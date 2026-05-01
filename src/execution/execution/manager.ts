import { createHash } from 'node:crypto'

import type { Logger } from 'pino'

import { normalizeSymbol } from '../../utils/symbol-normalizer.js'
import type { Clock, EventBus, IntentExitedEvent, OrderPlacedEvent, OrderFilledEvent, PositionOpenedEvent } from '../core/types.js'
import type { ExecutionIds } from '../core/ids.js'
import type { ExecutionMetrics } from '../observability/metrics.js'
import type { ExchangeRestAdapter, OrderSide } from '../adapters/rest/types.js'
import type { StateStore } from '../state/types.js'
import type { MarketMetadataProvider } from '../markets/types.js'
import type { KillSwitch } from '../risk/types.js'
import type { Exchange, Unsubscribe } from '../types/exchange.js'
import type { TradeIntent } from '../strategies/types.js'
import type { ExecutionManager, ExitOrderRef, ExitReason, IntentState, IntentStatus, PositionMonitor } from './types.js'
import type { PreflightResult } from './preflight.js'
import type { RiskConfig } from '../config/types.js'

const TERMINAL: ReadonlySet<IntentStatus> = new Set(['exited', 'error', 'cancelled'])

export interface ExecutionManagerInitialState {
  intentStates: Map<string, IntentState>
  byEntryOrderId: Map<string, string>
  byEntryExchangeOrderId: Map<string, string>
  byCloseOrderId: Map<string, string>
  byCloseExchangeOrderId: Map<string, string>
}

export interface BeforeCreateOrderParams {
  intentId: string
  clientOrderId: string
  exchange: Exchange
  symbol: string
  side: 'buy' | 'sell'
  orderType: 'market' | 'limit' | 'stop_market'
  kind: 'entry' | 'sl' | 'tp' | 'close' | 'timed'
  qty: number
  price?: number
  stopPrice?: number
  intendedPrice?: number
  reduceOnly: boolean
}

export interface ExecutionManagerOptions {
  bus: EventBus
  clock: Clock
  ids: ExecutionIds
  logger: Logger
  metrics: ExecutionMetrics
  restAdapters: Map<Exchange, ExchangeRestAdapter>
  state: StateStore
  markets: MarketMetadataProvider
  killSwitch: KillSwitch
  monitor: PositionMonitor
  preflight: (intent: TradeIntent, refPrice: number) => PreflightResult
  refPrice: (exchange: Exchange, symbol: string) => number | undefined
  risk?: RiskConfig
  initialState?: ExecutionManagerInitialState
  /** Called with full order params before createOrder — use for durability writes. */
  beforeCreateOrder?: (params: BeforeCreateOrderParams) => Promise<void>
}

export interface ExecutionManagerHandle extends ExecutionManager {
  start(): void
  stop(): void
  list(): IntentState[]
}

export function createExecutionManager(opts: ExecutionManagerOptions): ExecutionManagerHandle {
  const { bus, clock, ids, logger, metrics, restAdapters, monitor, preflight, refPrice } = opts

  const intentStates: Map<string, IntentState> = opts.initialState?.intentStates ?? new Map()
  // clientOrderId → intentId for entry orders
  const byEntryOrderId: Map<string, string> = opts.initialState?.byEntryOrderId ?? new Map()
  // exchangeOrderId → intentId for entry orders (fallback when clientOrderId absent in WS, e.g. Bitget/KuCoin market fills)
  const byEntryExchangeOrderId: Map<string, string> = opts.initialState?.byEntryExchangeOrderId ?? new Map()
  // clientOrderId → intentId for market-close orders (timed/deadline/kill_switch)
  const byCloseOrderId: Map<string, string> = opts.initialState?.byCloseOrderId ?? new Map()
  // exchangeOrderId → intentId for market-close orders (fallback)
  const byCloseExchangeOrderId: Map<string, string> = opts.initialState?.byCloseExchangeOrderId ?? new Map()
  // (exchange, symbol, leverage) → already-set flag
  const leverageSet = new Set<string>()
  // single-flight: prevents duplicate concurrent setLeverage calls for the same key
  const leverageInFlight = new Map<string, Promise<void>>()

  const stateChangeListeners = new Set<(state: IntentState) => void>()
  const busUnsubs: Unsubscribe[] = []
  // Track entry fill timestamps per intentId for exit latency metric
  const entryFilledAt = new Map<string, number>()

  // Canonicalize a clientOrderId for the given exchange (e.g. OKX strips dashes).
  // WS events arrive with the canonical form, so lookup maps must use canonical keys.
  function canonicalize(exchange: Exchange, id: string): string {
    return restAdapters.get(exchange)?.canonicalizeClientOrderId?.(id) ?? id
  }

  function ensureLeverage(
    rest: ExchangeRestAdapter,
    exchange: Exchange,
    exchangeSymbol: string,
    symbol: string,
    leverage: number
  ): Promise<void> {
    const key = `${exchange}:${symbol}:${String(leverage)}`
    if (leverageSet.has(key)) return Promise.resolve()
    const existing = leverageInFlight.get(key)
    if (existing) return existing
    const p = rest
      .setLeverage(exchangeSymbol, leverage)
      .then(() => {
        leverageSet.add(key)
      })
      .finally(() => {
        leverageInFlight.delete(key)
      })
    leverageInFlight.set(key, p)
    return p
  }

  function emitState(s: IntentState): void {
    s.updatedAt = clock.now()
    bus.emit('intent.state_changed', s)
    for (const l of stateChangeListeners) l(s)
  }

  function transition(s: IntentState, status: IntentStatus): void {
    if (TERMINAL.has(s.status)) return
    s.status = status
    emitState(s)
    metrics.intentsOpen.set(Array.from(intentStates.values()).filter(st => !TERMINAL.has(st.status)).length, {
      exchange: s.intent.exchange,
      strategy: s.intent.strategy,
      status,
    })
  }

  function setError(s: IntentState, code: string, message: string): void {
    if (TERMINAL.has(s.status)) return
    logger.warn(
      {
        event: 'intent.error',
        intentId: s.intent.id,
        exchange: s.intent.exchange,
        strategy: s.intent.strategy,
        code,
        errorMessage: message,
      },
      'intent.error'
    )
    s.error = { code, message, at: clock.now() }
    transition(s, 'error')
  }

  async function handleEntryFilled(s: IntentState): Promise<void> {
    const { intent } = s
    const rest = restAdapters.get(intent.exchange)
    if (!rest) {
      setError(s, 'no_adapter', 'no rest adapter for entry fills')
      return
    }

    if (intent.exitPolicy.kind === 'sl_tp_deadline') {
      const slId = ids.forExit(intent.id, 'sl')
      const tpId = ids.forExit(intent.id, 'tp')
      const exitSide: OrderSide = intent.side === 'long' ? 'sell' : 'buy'
      const { slPct, tpPct } = intent.exitPolicy
      const price = s.avgEntryPrice ?? refPrice(intent.exchange, intent.symbol) ?? 0

      if (price <= 0) {
        logger.warn(
          {
            event: 'handleEntryFilled.no_price',
            intentId: intent.id,
            exchange: intent.exchange,
            symbol: intent.symbol,
          },
          'handleEntryFilled: zero ref price — SL/TP not placed, deadline-only exit'
        )
      }
      if (price > 0) {
        const slPrice = intent.side === 'long' ? price * (1 - slPct / 100) : price * (1 + slPct / 100)
        const tpPrice = intent.side === 'long' ? price * (1 + tpPct / 100) : price * (1 - tpPct / 100)

        // Size SL/TP from actual exchange position rather than s.filledQty alone.
        // If a duplicate entry slipped past idempotency (Binance allows clientOrderId reuse
        // after the first order closes), the exchange-side position can be larger than what
        // we recorded. Using max(restQty, s.filledQty) ensures TP closes everything.
        let exitQty = s.filledQty
        try {
          const positions = await rest.getPositions(intent.exchangeSymbol)
          const pos = positions.find(p => p.symbol === intent.symbol || p.symbol === intent.exchangeSymbol)
          if (pos && pos.qty > s.filledQty) {
            logger.error(
              {
                event: 'handleEntryFilled.position_oversized',
                intentId: intent.id,
                exchange: intent.exchange,
                symbol: intent.symbol,
                expectedQty: s.filledQty,
                actualQty: pos.qty,
              },
              'handleEntryFilled: REST position exceeds recorded fill — sizing SL/TP to actual'
            )
            exitQty = pos.qty
          }
        } catch (err) {
          logger.warn(
            { intentId: intent.id, err },
            'handleEntryFilled: getPositions failed — using s.filledQty for SL/TP'
          )
        }

        if (opts.beforeCreateOrder) {
          await Promise.all([
            opts.beforeCreateOrder({
              intentId: intent.id,
              clientOrderId: slId,
              exchange: intent.exchange,
              symbol: intent.exchangeSymbol,
              side: exitSide,
              kind: 'sl',
              orderType: 'stop_market',
              qty: exitQty,
              stopPrice: slPrice,
              reduceOnly: true,
            }).catch((err: unknown) => logger.warn({ intentId: intent.id, err }, 'manager: durability write failed for sl order')),
            opts.beforeCreateOrder({
              intentId: intent.id,
              clientOrderId: tpId,
              exchange: intent.exchange,
              symbol: intent.exchangeSymbol,
              side: exitSide,
              kind: 'tp',
              orderType: 'limit',
              qty: exitQty,
              price: tpPrice,
              reduceOnly: true,
            }).catch((err: unknown) => logger.warn({ intentId: intent.id, err }, 'manager: durability write failed for tp order')),
          ])
        }

        const [slResult, tpResult] = await Promise.allSettled([
          rest.createOrder({
            intentId: intent.id,
            clientOrderId: slId,
            exchange: intent.exchange,
            symbol: intent.exchangeSymbol,
            side: exitSide,
            type: 'stop_market',
            qty: exitQty,
            stopPrice: slPrice,
            reduceOnly: true,
          }),
          rest.createOrder({
            intentId: intent.id,
            clientOrderId: tpId,
            exchange: intent.exchange,
            symbol: intent.exchangeSymbol,
            side: exitSide,
            type: 'limit',
            qty: exitQty,
            price: tpPrice,
            reduceOnly: true,
          }),
        ])

        if (slResult.status === 'fulfilled') {
          const slPlaced: OrderPlacedEvent = {
            intentId: intent.id,
            exchange: intent.exchange,
            symbol: intent.symbol,
            clientOrderId: slId,
            kind: 'sl',
            side: exitSide,
            orderType: 'stop_market',
            qty: exitQty,
            stopPrice: slPrice,
            reduceOnly: true,
            ...(slResult.value.exchangeOrderId ? { exchangeOrderId: slResult.value.exchangeOrderId } : {}),
          }
          bus.emit('order.placed', slPlaced)
          logger.info({ event: 'order.placed', ...slPlaced }, 'order.placed')
          s.exitOrderRefs = {
            ...s.exitOrderRefs,
            sl: {
              clientOrderId: canonicalize(intent.exchange, slId),
              ...(slResult.value.exchangeOrderId ? { exchangeOrderId: slResult.value.exchangeOrderId } : {}),
            },
          }
        } else {
          logger.warn({ intentId: intent.id, err: slResult.reason }, 'manager: sl order placement failed')
        }

        if (tpResult.status === 'fulfilled') {
          const tpPlaced: OrderPlacedEvent = {
            intentId: intent.id,
            exchange: intent.exchange,
            symbol: intent.symbol,
            clientOrderId: tpId,
            kind: 'tp',
            side: exitSide,
            orderType: 'limit',
            qty: exitQty,
            price: tpPrice,
            reduceOnly: true,
            ...(tpResult.value.exchangeOrderId ? { exchangeOrderId: tpResult.value.exchangeOrderId } : {}),
          }
          bus.emit('order.placed', tpPlaced)
          logger.info({ event: 'order.placed', ...tpPlaced }, 'order.placed')
          s.exitOrderRefs = {
            ...s.exitOrderRefs,
            tp: {
              clientOrderId: canonicalize(intent.exchange, tpId),
              ...(tpResult.value.exchangeOrderId ? { exchangeOrderId: tpResult.value.exchangeOrderId } : {}),
            },
          }
        } else {
          logger.warn({ intentId: intent.id, err: tpResult.reason }, 'manager: tp order placement failed')
        }
      }
    }

    const posOpened: PositionOpenedEvent = {
      intentId: intent.id,
      exchange: intent.exchange,
      symbol: intent.symbol,
      side: intent.side,
      filledQty: s.filledQty,
      ...(s.avgEntryPrice !== undefined ? { avgEntryPrice: s.avgEntryPrice } : {}),
    }
    bus.emit('position.opened', posOpened)
    logger.info({ event: 'position.opened', ...posOpened }, 'position.opened')

    transition(s, 'monitoring')
    monitor.arm(s)
    // REST fallback: poll for SL/TP fills in case a WS reconnect gap causes the monitor to miss them
    if (intent.exitPolicy.kind === 'sl_tp_deadline' && s.exitOrderRefs && (s.exitOrderRefs.sl || s.exitOrderRefs.tp)) {
      void pollForSlTpFill(s)
    }
  }

  function handleEntryOrderEvent(
    s: IntentState,
    order: { clientOrderId: string; status: string; filledQty: number; avgFillPrice?: number }
  ): void {
    if (TERMINAL.has(s.status)) return

    if (order.filledQty > s.filledQty) {
      s.filledQty = order.filledQty
      if (order.avgFillPrice !== undefined) {
        s.avgEntryPrice = order.avgFillPrice
      }
    }

    if (order.status === 'filled') {
      // Guard: WS adapters can replay fill events on reconnect. Only process from pre-fill states.
      if (s.status !== 'working' && s.status !== 'partially_filled' && s.status !== 'acked' && s.status !== 'submitted')
        return
      const now = clock.now()
      metrics.intentEntryLatencyMs.observe(now - s.intent.decidedAt, {
        exchange: s.intent.exchange,
        strategy: s.intent.strategy,
      })
      entryFilledAt.set(s.intent.id, now)
      metrics.intentFilledTotal.inc(1, { exchange: s.intent.exchange, strategy: s.intent.strategy })
      const filled: OrderFilledEvent = {
        intentId: s.intent.id,
        exchange: s.intent.exchange,
        symbol: s.intent.symbol,
        clientOrderId: order.clientOrderId,
        filledQty: order.filledQty,
        ...(order.avgFillPrice !== undefined ? { avgFillPrice: order.avgFillPrice } : {}),
      }
      bus.emit('order.filled', filled)
      logger.info({ event: 'order.filled', ...filled }, 'order.filled')
      transition(s, 'filled')
      void handleEntryFilled(s)
    } else if (order.status === 'partially_filled') {
      transition(s, 'partially_filled')
    } else if (order.status === 'cancelled' || order.status === 'rejected') {
      setError(s, order.status, `entry order ${order.status}`)
    }
  }

  const POLL_GET_ORDER_TIMEOUT_MS = 3_000

  function withGetOrderTimeout(
    promise: Promise<import('../adapters/rest/types.js').Order | undefined>
  ): Promise<import('../adapters/rest/types.js').Order | undefined> {
    return Promise.race([
      promise,
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), POLL_GET_ORDER_TIMEOUT_MS)),
    ])
  }

  async function pollForEntryFill(
    s: IntentState,
    clientOrderId: string,
    exchangeOrderId: string,
    rest: ExchangeRestAdapter
  ): Promise<void> {
    const MAX_POLLS = 15
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise<void>(r => setTimeout(r, 1000))
      if (TERMINAL.has(s.status) || s.status !== 'working') return
      try {
        const ref = exchangeOrderId
          ? { symbol: s.intent.exchangeSymbol, clientOrderId, exchangeOrderId }
          : { symbol: s.intent.exchangeSymbol, clientOrderId }
        const order = await withGetOrderTimeout(rest.getOrder(ref))
        if (order) handleEntryOrderEvent(s, order)
      } catch (err) {
        logger.warn({ intentId: s.intent.id, attempt: i + 1, err }, 'manager: entry poll failed')
      }
    }
  }

  async function pollForCloseFill(
    s: IntentState,
    closeId: string,
    closeExchangeOrderId: string,
    rest: ExchangeRestAdapter
  ): Promise<void> {
    const MAX_POLLS = 20
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise<void>(r => setTimeout(r, 1000))
      if (TERMINAL.has(s.status) || s.status !== 'exiting') return
      try {
        const ref = closeExchangeOrderId
          ? { symbol: s.intent.exchangeSymbol, clientOrderId: closeId, exchangeOrderId: closeExchangeOrderId }
          : { symbol: s.intent.exchangeSymbol, clientOrderId: closeId }
        const order = await rest.getOrder(ref)
        if (order?.status === 'filled') {
          if (order.avgFillPrice !== undefined) s.avgExitPrice = order.avgFillPrice
          recordExitMetrics(s, s.exitReason ?? 'error')
          emitIntentExited(s)
          transition(s, 'exited')
          void sweepReduceOnlyOrders(rest, s.intent.exchangeSymbol, s.intent.id)
          return
        }
        // Fallback: if order not found (e.g. Bitget archives filled market orders quickly),
        // confirm close via position size — if the symbol has no open position the close filled.
        if (order === undefined) {
          const positions = await rest.getPositions(s.intent.exchangeSymbol)
          const pos = positions.find(p => p.symbol === s.intent.symbol || p.symbol.includes(s.intent.symbol))
          if (!pos || pos.qty === 0) {
            recordExitMetrics(s, s.exitReason ?? 'error')
            emitIntentExited(s)
            transition(s, 'exited')
            void sweepReduceOnlyOrders(rest, s.intent.exchangeSymbol, s.intent.id)
            return
          }
        }
      } catch (err) {
        logger.warn({ intentId: s.intent.id, attempt: i + 1, err }, 'manager: close poll failed')
      }
    }
    logger.error(
      { intentId: s.intent.id, exchange: s.intent.exchange, symbol: s.intent.symbol },
      'manager: close poll exhausted — intent stuck in exiting, manual intervention required'
    )
    metrics.intentRejectedTotal.inc(1, {
      exchange: s.intent.exchange,
      strategy: s.intent.strategy,
      code: 'close_poll_exhausted',
    })
  }

  async function pollForSlTpFill(s: IntentState): Promise<void> {
    const { intent } = s
    const rest = restAdapters.get(intent.exchange)
    if (!rest || !s.exitOrderRefs) return
    const { sl: slRef, tp: tpRef } = s.exitOrderRefs
    if (!slRef && !tpRef) return

    const POLL_INTERVAL_MS = 15_000
    const MAX_POLLS = 50 // 50 × 15s = ~12 min, well within any deadline

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS))
      if (s.status !== 'monitoring') return

      try {
        if (slRef) {
          const slOrder = await withGetOrderTimeout(
            rest.getOrder({
              symbol: intent.exchangeSymbol,
              clientOrderId: slRef.clientOrderId,
              ...(slRef.exchangeOrderId ? { exchangeOrderId: slRef.exchangeOrderId } : {}),
            })
          )
          if (slOrder?.status === 'filled' && s.status === 'monitoring') {
            if (slOrder.avgFillPrice !== undefined) s.avgExitPrice = slOrder.avgFillPrice
            monitor.disarm(intent.id)
            await handleMonitorExit(s, 'sl')
            return
          }
        }
        if (s.status !== 'monitoring') return
        if (tpRef) {
          const tpOrder = await withGetOrderTimeout(
            rest.getOrder({
              symbol: intent.exchangeSymbol,
              clientOrderId: tpRef.clientOrderId,
              ...(tpRef.exchangeOrderId ? { exchangeOrderId: tpRef.exchangeOrderId } : {}),
            })
          )
          if (tpOrder?.status === 'filled' && s.status === 'monitoring') {
            if (tpOrder.avgFillPrice !== undefined) s.avgExitPrice = tpOrder.avgFillPrice
            monitor.disarm(intent.id)
            await handleMonitorExit(s, 'tp')
            return
          }
        }
      } catch (err) {
        logger.warn({ intentId: intent.id, attempt: i + 1, err }, 'manager: sl/tp poll failed')
      }
    }
  }

  async function sweepReduceOnlyOrders(
    rest: ExchangeRestAdapter,
    exchangeSymbol: string,
    intentId: string
  ): Promise<void> {
    logger.info(
      { event: 'oco.sweep.start', intentId, exchange: rest.exchange, symbol: exchangeSymbol },
      'oco.sweep.start'
    )
    try {
      const open = await rest.getOpenOrders(exchangeSymbol)
      const reduceOnly = open.filter(o => o.reduceOnly)
      if (reduceOnly.length === 0) {
        logger.info(
          { event: 'oco.sweep.complete', intentId, exchange: rest.exchange, symbol: exchangeSymbol, foundCount: 0, cancelledCount: 0 },
          'oco.sweep.complete'
        )
        return
      }
      const results = await Promise.allSettled(
        reduceOnly.map(o =>
          rest
            .cancelOrder({
              symbol: exchangeSymbol,
              ...(o.clientOrderId ? { clientOrderId: o.clientOrderId } : {}),
              ...(o.exchangeOrderId ? { exchangeOrderId: o.exchangeOrderId } : {}),
            })
            .catch((err: unknown) =>
              logger.warn(
                { intentId, exchange: rest.exchange, orderId: o.clientOrderId, err },
                'manager: post-exit cancel failed'
              )
            )
        )
      )
      const cancelledCount = results.filter(r => r.status === 'fulfilled').length
      logger.info(
        { event: 'oco.sweep.complete', intentId, exchange: rest.exchange, symbol: exchangeSymbol, foundCount: reduceOnly.length, cancelledCount },
        'oco.sweep.complete'
      )
    } catch (err) {
      logger.warn({ intentId, exchange: rest.exchange, symbol: exchangeSymbol, err }, 'manager: post-exit sweep failed')
    }
  }

  async function cancelSiblingExit(
    rest: ExchangeRestAdapter,
    intent: TradeIntent,
    ref: ExitOrderRef
  ): Promise<'cancelled' | 'not_open' | 'failed'> {
    const { exchange, symbol, exchangeSymbol } = intent
    const intentId = intent.id
    const ctx = { intentId, exchange, symbol, clientOrderId: ref.clientOrderId, exchangeOrderId: ref.exchangeOrderId }
    logger.info({ event: 'oco.cancel.start', ...ctx }, 'oco.cancel.start')

    async function isStillOpen(): Promise<boolean> {
      try {
        const open = await rest.getOpenOrders(exchangeSymbol)
        return open.some(
          o =>
            o.clientOrderId === ref.clientOrderId ||
            (ref.exchangeOrderId !== undefined && o.exchangeOrderId === ref.exchangeOrderId)
        )
      } catch {
        return true // assume open if check fails
      }
    }

    // Strategy A: cancel by clientOrderId
    logger.info({ event: 'oco.cancel.attempt', strategy: 'A', ...ctx }, 'oco.cancel.attempt')
    try {
      await rest.cancelOrder({ symbol: exchangeSymbol, clientOrderId: ref.clientOrderId })
    } catch {
      // swallow — open-orders list is ground truth
    }
    if (!(await isStillOpen())) {
      logger.info({ event: 'oco.cancel.success', strategy: 'A', ...ctx }, 'oco.cancel.success')
      return 'cancelled'
    }
    logger.warn({ event: 'oco.cancel.strategy_failed', strategy: 'A', ...ctx }, 'oco.cancel.strategy_A_failed')

    // Strategy B: cancel by exchangeOrderId (fallback when clientOrderId path silently no-ops)
    if (ref.exchangeOrderId) {
      logger.info({ event: 'oco.cancel.attempt', strategy: 'B', ...ctx }, 'oco.cancel.attempt')
      try {
        await rest.cancelOrder({ symbol: exchangeSymbol, exchangeOrderId: ref.exchangeOrderId })
      } catch {
        // swallow
      }
      if (!(await isStillOpen())) {
        logger.info({ event: 'oco.cancel.success', strategy: 'B', ...ctx }, 'oco.cancel.success')
        return 'cancelled'
      }
      logger.warn({ event: 'oco.cancel.strategy_failed', strategy: 'B', ...ctx }, 'oco.cancel.strategy_B_failed')
    }

    // Strategy C: sweep all reduce-only orders for symbol
    logger.info({ event: 'oco.cancel.attempt', strategy: 'C', ...ctx }, 'oco.cancel.attempt')
    await sweepReduceOnlyOrders(rest, exchangeSymbol, intentId)
    if (!(await isStillOpen())) {
      logger.info({ event: 'oco.cancel.success', strategy: 'C', ...ctx }, 'oco.cancel.success')
      return 'cancelled'
    }

    logger.error(
      { event: 'oco.cancel.exhausted', ...ctx },
      'oco.cancel.exhausted: sibling order may remain on exchange'
    )
    return 'failed'
  }

  async function handleMonitorExit(s: IntentState, reason: ExitReason): Promise<void> {
    if (TERMINAL.has(s.status) || s.status === 'exiting') return

    const exitStartedAt = clock.now()
    logger.info(
      { event: 'intent.exiting.start', intentId: s.intent.id, exchange: s.intent.exchange, symbol: s.intent.symbol, reason },
      'intent.exiting.start'
    )

    s.exitReason = reason
    transition(s, 'exiting')

    const { intent } = s
    const rest = restAdapters.get(intent.exchange)
    if (!rest) {
      setError(s, 'no_adapter', 'no rest adapter for exit')
      return
    }

    const exitSide: OrderSide = intent.side === 'long' ? 'sell' : 'buy'

    if (reason === 'sl' || reason === 'tp') {
      // One exit order already filled (detected by monitor). Cancel the residual.
      const residualRef = reason === 'sl' ? s.exitOrderRefs?.tp : s.exitOrderRefs?.sl
      if (residualRef) {
        await cancelSiblingExit(rest, intent, residualRef)
      }
      // Defense in depth: sweep any remaining reduce-only orders for this symbol.
      // cancelSiblingExit above can exhaust all strategies; a duplicate SL placement may also
      // have slipped through. The sweep ensures no orphaned reduce-only orders remain after exit.
      await sweepReduceOnlyOrders(rest, intent.exchangeSymbol, intent.id)
      recordExitMetrics(s, reason)
      emitIntentExited(s)
      transition(s, 'exited')
      logger.info(
        { event: 'intent.exited.complete', intentId: intent.id, exchange: intent.exchange, symbol: intent.symbol, exitReason: reason, durationMs: clock.now() - exitStartedAt },
        'intent.exited.complete'
      )
    } else {
      // timed / deadline / kill_switch → cancel existing exit orders, place market close
      if (s.exitOrderRefs) {
        const refs = [s.exitOrderRefs.sl, s.exitOrderRefs.tp].filter((r): r is ExitOrderRef => r !== undefined)
        for (const ref of refs) {
          await cancelSiblingExit(rest, intent, ref)
        }
      }

      const closeKind = reason === 'timed' ? 'timed' : 'close'
      const closeId = ids.forExit(intent.id, closeKind)
      const canonCloseId = canonicalize(intent.exchange, closeId)
      // Register BEFORE placing so racing WS fill events are not missed.
      s.exitOrderRefs = { close: { clientOrderId: closeId } }
      byCloseOrderId.set(canonCloseId, intent.id)
      if (opts.beforeCreateOrder) {
        try {
          await opts.beforeCreateOrder({
            intentId: intent.id,
            clientOrderId: closeId,
            exchange: intent.exchange,
            symbol: intent.exchangeSymbol,
            side: exitSide,
            kind: closeKind,
            orderType: 'market',
            qty: s.filledQty,
            reduceOnly: true,
          })
        } catch (err) {
          logger.warn({ intentId: intent.id, err }, 'manager: durability write failed for close order')
        }
      }
      try {
        const closeAck = await rest.createOrder({
          intentId: intent.id,
          clientOrderId: closeId,
          exchange: intent.exchange,
          symbol: intent.exchangeSymbol,
          side: exitSide,
          type: 'market',
          qty: s.filledQty,
          reduceOnly: true,
        })
        if (closeAck.exchangeOrderId) {
          byCloseExchangeOrderId.set(closeAck.exchangeOrderId, intent.id)
          s.exitOrderRefs = { close: { clientOrderId: closeId, exchangeOrderId: closeAck.exchangeOrderId } }
        }
        const closePlaced: OrderPlacedEvent = {
          intentId: intent.id,
          exchange: intent.exchange,
          symbol: intent.symbol,
          clientOrderId: closeId,
          kind: closeKind,
          side: exitSide,
          orderType: 'market',
          qty: s.filledQty,
          reduceOnly: true,
          ...(closeAck.exchangeOrderId ? { exchangeOrderId: closeAck.exchangeOrderId } : {}),
        }
        bus.emit('order.placed', closePlaced)
        logger.info({ event: 'order.placed', ...closePlaced }, 'order.placed')
        // REST polling fallback for close fill (mirrors entry poll for WS-unreliable exchanges)
        void pollForCloseFill(s, closeId, closeAck.exchangeOrderId, rest)
      } catch (err) {
        byCloseOrderId.delete(canonCloseId)
        delete s.exitOrderRefs
        logger.error({ intentId: intent.id, err }, 'manager: market close placement failed')
        setError(s, 'close_failed', String(err))
      }
    }
  }

  function recordExitMetrics(s: IntentState, reason: ExitReason): void {
    const filledAt = entryFilledAt.get(s.intent.id) ?? s.intent.decidedAt
    metrics.intentExitLatencyMs.observe(clock.now() - filledAt, {
      exchange: s.intent.exchange,
      strategy: s.intent.strategy,
    })
    metrics.intentTerminalTotal.inc(1, {
      exchange: s.intent.exchange,
      strategy: s.intent.strategy,
      exit_reason: reason,
    })
  }

  function emitIntentExited(s: IntentState): void {
    const exitFilledAt = clock.now()
    const event: IntentExitedEvent = {
      intentId: s.intent.id,
      exchange: s.intent.exchange,
      symbol: s.intent.symbol,
      side: s.intent.side,
      qty: s.filledQty,
      exitReason: s.exitReason ?? 'error',
      decidedAt: s.intent.decidedAt,
      exitFilledAt,
    }
    if (s.avgEntryPrice !== undefined) event.avgEntryPrice = s.avgEntryPrice
    if (s.avgExitPrice !== undefined) event.avgExitPrice = s.avgExitPrice
    const entryAt = entryFilledAt.get(s.intent.id)
    if (entryAt !== undefined) event.entryFilledAt = entryAt
    bus.emit('intent.exited', event)
  }

  // Smart risk preemption helpers
  function findWorstPreemptable(
    scope: 'global' | { strategy: string },
    incomingFundingRate: number
  ): IntentState | null {
    const candidates = Array.from(intentStates.values()).filter(s => {
      if (TERMINAL.has(s.status)) return false
      if (s.status === 'monitoring' || s.status === 'exiting' || s.status === 'filled') return false
      if (scope !== 'global' && (scope as { strategy: string }).strategy !== s.intent.strategy) return false
      return true
    })
    if (candidates.length === 0) return null
    const worst = candidates.reduce((w, s) => (s.intent.fundingRate > w.intent.fundingRate ? s : w))
    return worst.intent.fundingRate > incomingFundingRate ? worst : null
  }

  function preemptSynchronously(s: IntentState): void {
    const rest = restAdapters.get(s.intent.exchange)
    logger.info(
      {
        intentId: s.intent.id,
        exchange: s.intent.exchange,
        symbol: s.intent.symbol,
        fundingRate: s.intent.fundingRate,
      },
      'intent.preempted'
    )
    metrics.intentRejectedTotal.inc(1, { exchange: s.intent.exchange, strategy: s.intent.strategy, code: 'preempted' })

    if (s.filledQty > 0) {
      // Entry partially filled — cancel remaining entry order then close the open partial position
      if (rest && s.entryOrderId) {
        void rest
          .cancelOrder({ symbol: s.intent.exchangeSymbol, clientOrderId: s.entryOrderId })
          .catch((err: unknown) => logger.warn({ intentId: s.intent.id, err }, 'preempt: cancel entry failed'))
      }
      void handleMonitorExit(s, 'kill_switch')
      return
    }

    // Clean up lookup maps before going terminal
    if (s.entryOrderId) byEntryOrderId.delete(canonicalize(s.intent.exchange, s.entryOrderId))
    if (s.entryExchangeOrderId) byEntryExchangeOrderId.delete(s.entryExchangeOrderId)
    transition(s, 'cancelled')
    if (rest && s.entryOrderId) {
      void rest
        .cancelOrder({ symbol: s.intent.exchangeSymbol, clientOrderId: s.entryOrderId })
        .catch((err: unknown) =>
          logger.warn({ intentId: s.intent.id, err }, 'preempt: cancel order failed (best effort)')
        )
    }
  }

  // Tracks in-flight orphan-flatten ops to prevent concurrent reduce-only orders for the
  // same (exchange, symbol) when reconcile fires desync events repeatedly.
  const flattenInFlight = new Set<string>()
  // Tracks in-flight orphan reduce-only order cancellations to dedupe repeated reconcile passes.
  const orphanCancelInFlight = new Set<string>()

  async function cancelOrphanReduceOnlyOrder(
    exchange: Exchange,
    details: { symbol: string; clientOrderId: string; exchangeOrderId?: string }
  ): Promise<void> {
    const rest = restAdapters.get(exchange)
    if (!rest) return
    const key = `${exchange}:${details.clientOrderId}`
    if (orphanCancelInFlight.has(key)) return
    orphanCancelInFlight.add(key)
    logger.warn(
      {
        event: 'orphan_reduce_only_order.cancel',
        exchange,
        symbol: details.symbol,
        clientOrderId: details.clientOrderId,
        exchangeOrderId: details.exchangeOrderId,
      },
      'orphan_reduce_only_order: cancelling stale reduce-only order with no matching position'
    )
    try {
      await rest.cancelOrder({
        symbol: details.symbol,
        clientOrderId: details.clientOrderId,
        ...(details.exchangeOrderId ? { exchangeOrderId: details.exchangeOrderId } : {}),
      })
    } catch (err) {
      logger.warn(
        { event: 'orphan_reduce_only_order.cancel_failed', exchange, symbol: details.symbol, err },
        'orphan_reduce_only_order: cancel failed (best effort)'
      )
    } finally {
      orphanCancelInFlight.delete(key)
    }
  }

  async function flattenOrphanPosition(
    exchange: Exchange,
    details: { symbol: string; localQty: number; restQty: number; restSide?: 'long' | 'short' | 'flat' }
  ): Promise<void> {
    if (details.restSide === 'flat' || details.restQty <= 0) return
    if (details.restQty <= details.localQty) return

    const rest = restAdapters.get(exchange)
    if (!rest) return

    const desyncSymbol = details.symbol
    const normalized = normalizeSymbol(desyncSymbol)
    const key = `${exchange}:${normalized}`
    if (flattenInFlight.has(key)) return

    // Sum recorded fills across all active intents for this symbol+exchange so we don't
    // close legitimate concurrent positions — only the surplus.
    const expectedQty = Array.from(intentStates.values())
      .filter(
        s =>
          s.intent.exchange === exchange &&
          normalizeSymbol(s.intent.symbol) === normalized &&
          (s.status === 'filled' ||
            s.status === 'monitoring' ||
            s.status === 'exiting' ||
            s.status === 'partially_filled') &&
          s.filledQty > 0
      )
      .reduce((acc, s) => acc + s.filledQty, 0)

    const surplus = details.restQty - expectedQty
    if (surplus <= 1e-9) return

    const flattenSide: OrderSide = details.restSide === 'long' ? 'sell' : details.restSide === 'short' ? 'buy' : 'buy'
    // Deterministic clientOrderId per minute prevents thundering herd if reconcile re-fires.
    const minuteBucket = Math.floor(clock.now() / 60_000)
    const clientOrderId = createHash('sha256')
      .update(`flatten|${exchange}|${normalized}|${String(minuteBucket)}`)
      .digest('hex')
      .slice(0, 28)

    flattenInFlight.add(key)
    logger.error(
      {
        event: 'orphan_flatten.start',
        exchange,
        symbol: desyncSymbol,
        normalized,
        restQty: details.restQty,
        expectedQty,
        surplus,
        flattenSide,
        clientOrderId,
      },
      'orphan_flatten: closing surplus position detected by reconciler'
    )
    try {
      await rest.createOrder({
        intentId: `orphan_flatten:${exchange}:${normalized}`,
        clientOrderId,
        exchange,
        symbol: desyncSymbol,
        side: flattenSide,
        type: 'market',
        qty: surplus,
        reduceOnly: true,
      })
      logger.warn(
        { event: 'orphan_flatten.placed', exchange, symbol: desyncSymbol, surplus, clientOrderId },
        'orphan_flatten: reduce-only market order placed'
      )
    } catch (err) {
      logger.error(
        { event: 'orphan_flatten.failed', exchange, symbol: desyncSymbol, surplus, err },
        'orphan_flatten: failed to place reduce-only market'
      )
    } finally {
      flattenInFlight.delete(key)
    }
  }

  return {
    start(): void {
      // Re-arm the position monitor for any intents that were rehydrated from DB in an
      // active monitored state. Without this, deadline timers are never set after recovery.
      for (const s of intentStates.values()) {
        if (s.status === 'monitoring' || s.status === 'exiting') {
          monitor.arm(s)
        }
      }

      busUnsubs.push(
        bus.on('ws.order', event => {
          const { clientOrderId, exchangeOrderId } = event.order
          const entryIntentId =
            byEntryOrderId.get(clientOrderId) ??
            (exchangeOrderId ? byEntryExchangeOrderId.get(exchangeOrderId) : undefined)
          if (entryIntentId !== undefined) {
            const s = intentStates.get(entryIntentId)
            if (s) handleEntryOrderEvent(s, event.order)
          }

          const closeIntentId =
            byCloseOrderId.get(clientOrderId) ??
            (exchangeOrderId ? byCloseExchangeOrderId.get(exchangeOrderId) : undefined)
          if (closeIntentId !== undefined) {
            const s = intentStates.get(closeIntentId)
            if (s && event.order.status === 'filled') {
              if (event.order.avgFillPrice !== undefined) {
                s.avgExitPrice = event.order.avgFillPrice
              }
              const closeFilled: OrderFilledEvent = {
                intentId: closeIntentId,
                exchange: s.intent.exchange,
                symbol: s.intent.symbol,
                clientOrderId,
                filledQty: event.order.filledQty,
                ...(event.order.avgFillPrice !== undefined ? { avgFillPrice: event.order.avgFillPrice } : {}),
              }
              bus.emit('order.filled', closeFilled)
              logger.info({ event: 'order.filled', ...closeFilled }, 'order.filled')
              recordExitMetrics(s, s.exitReason ?? 'error')
              emitIntentExited(s)
              transition(s, 'exited')
              const wsRest = restAdapters.get(s.intent.exchange)
              if (wsRest) void sweepReduceOnlyOrders(wsRest, s.intent.exchangeSymbol, s.intent.id)
            }
          }
        })
      )

      busUnsubs.push(
        monitor.onExitRequested((intentId, reason) => {
          const s = intentStates.get(intentId)
          if (s) void handleMonitorExit(s, reason)
        })
      )

      // Auto-flatten orphan exchange-side positions and cancel orphan reduce-only orders
      // detected by the reconciler. Together these guarantee that when SL or TP fills, no
      // stale orders or position residuals remain on any exchange.
      busUnsubs.push(
        opts.state.onDesync(event => {
          if (event.kind === 'position_qty_mismatch') {
            const details = event.details as {
              symbol: string
              localQty: number
              restQty: number
              restSide?: 'long' | 'short' | 'flat'
            }
            if (typeof details?.symbol !== 'string') return
            void flattenOrphanPosition(event.exchange, details)
            return
          }
          if (event.kind === 'orphan_reduce_only_order') {
            const details = event.details as {
              symbol: string
              clientOrderId: string
              exchangeOrderId?: string
            }
            if (typeof details?.symbol !== 'string' || typeof details?.clientOrderId !== 'string') return
            void cancelOrphanReduceOnlyOrder(event.exchange, details)
          }
        })
      )
    },

    stop(): void {
      for (const unsub of busUnsubs) unsub()
      busUnsubs.length = 0
    },

    list(): IntentState[] {
      return Array.from(intentStates.values())
    },

    async submit(intent: TradeIntent): Promise<IntentState> {
      const existing = intentStates.get(intent.id)
      if (existing && !TERMINAL.has(existing.status)) {
        logger.warn({ intentId: intent.id, status: existing.status }, 'manager: duplicate intent submission ignored')
        return existing
      }

      const price = refPrice(intent.exchange, intent.symbol)
      const s: IntentState = {
        intent,
        status: 'decided',
        filledQty: 0,
        updatedAt: clock.now(),
      }
      intentStates.set(intent.id, s)
      bus.emit('intent.created', s)
      logger.info(
        {
          event: 'intent.created',
          intentId: intent.id,
          exchange: intent.exchange,
          symbol: intent.symbol,
          strategy: intent.strategy,
        },
        'intent.created'
      )
      emitState(s)

      if (price === undefined) {
        setError(s, 'no_ref_price', `no ref price for ${intent.exchange}/${intent.symbol}`)
        metrics.intentRejectedTotal.inc(1, {
          exchange: intent.exchange,
          strategy: intent.strategy,
          code: 'no_ref_price',
        })
        return s
      }

      // Smart preemption: if a risk cap would be hit, synchronously cancel the worst
      // (least-negative funding rate) non-monitoring intent to make room for this one.
      if (opts.risk) {
        const stratCfg = opts.risk.perStrategy[intent.strategy]
        if (stratCfg) {
          const stratActive = Array.from(intentStates.values()).filter(
            s2 => s2.intent.strategy === intent.strategy && !TERMINAL.has(s2.status) && s2.intent.id !== intent.id
          ).length
          if (stratActive >= stratCfg.maxConcurrentIntents) {
            const worst = findWorstPreemptable({ strategy: intent.strategy }, intent.fundingRate)
            if (worst) preemptSynchronously(worst)
          }
        }
        const globalActive = Array.from(intentStates.values()).filter(
          s2 => !TERMINAL.has(s2.status) && s2.intent.id !== intent.id
        ).length
        if (globalActive >= opts.risk.globalMaxConcurrentIntents) {
          const worst = findWorstPreemptable('global', intent.fundingRate)
          if (worst) preemptSynchronously(worst)
        }
      }

      const check = preflight(intent, price)
      if (!check.ok) {
        setError(s, check.code, check.message)
        metrics.intentRejectedTotal.inc(1, {
          exchange: intent.exchange,
          strategy: intent.strategy,
          code: check.code,
        })
        return s
      }

      const rest = restAdapters.get(intent.exchange)
      if (!rest) {
        setError(s, 'no_adapter', `no rest adapter for ${intent.exchange}`)
        return s
      }

      // Set leverage (idempotent per (exchange, symbol, leverage)).
      // Failure is a hard reject: proceeding at unknown exchange-default leverage would
      // invalidate the margin check in preflight and distort position sizing.
      // ensureLeverage shares a single HTTP call with any concurrent prewarm for the
      // same key, so the prewarm's in-flight promise is awaited rather than duplicated.
      try {
        await ensureLeverage(rest, intent.exchange, intent.exchangeSymbol, intent.symbol, intent.leverage)
      } catch (err) {
        setError(s, 'set_leverage_failed', `setLeverage failed: ${String(err)}`)
        metrics.intentRejectedTotal.inc(1, {
          exchange: intent.exchange,
          strategy: intent.strategy,
          code: 'set_leverage_failed',
        })
        return s
      }

      const clientOrderId = ids.forIntent(intent.id, 0)
      s.entryOrderId = clientOrderId
      const canonEntryId = canonicalize(intent.exchange, clientOrderId)

      // Register BEFORE placing so that any WS fill events that arrive during the REST
      // call (e.g. immediate market-order fill) are routed correctly. Use canonical form
      // so the incoming WS clientOrderId matches on exchanges that transform it (OKX).
      byEntryOrderId.set(canonEntryId, intent.id)

      transition(s, 'submitted')
      bus.emit('intent.submitted', s)
      logger.info(
        {
          event: 'intent.submitted',
          intentId: intent.id,
          exchange: intent.exchange,
          symbol: intent.symbol,
          strategy: intent.strategy,
        },
        'intent.submitted'
      )

      const entrySide: 'buy' | 'sell' = intent.side === 'long' ? 'buy' : 'sell'

      // Durability point: write the order row to DB before calling createOrder so that
      // on crash-restart the order is recognized and not cancelled as an orphan.
      if (opts.beforeCreateOrder) {
        try {
          await opts.beforeCreateOrder({
            intentId: intent.id,
            clientOrderId,
            exchange: intent.exchange,
            symbol: intent.exchangeSymbol,
            side: entrySide,
            kind: 'entry',
            orderType: 'market',
            qty: check.qty,
            reduceOnly: false,
          })
        } catch (err) {
          logger.warn(
            { intentId: intent.id, err },
            'manager: durability write failed — proceeding without pre-submit persistence'
          )
        }
      }

      let ack
      try {
        ack = await rest.createOrder({
          intentId: intent.id,
          clientOrderId,
          exchange: intent.exchange,
          symbol: intent.exchangeSymbol,
          side: entrySide,
          type: 'market',
          qty: check.qty,
          leverage: intent.leverage,
        })
      } catch (err) {
        byEntryOrderId.delete(canonEntryId)
        setError(s, 'create_order_failed', String(err))
        return s
      }

      if (ack.status === 'rejected') {
        byEntryOrderId.delete(canonEntryId)
        setError(s, 'order_rejected', ack.rejectReason ?? 'order rejected')
        return s
      }

      // Register exchangeOrderId as fallback routing key (covers exchanges that omit
      // clientOrderId from WS market-order fill events, e.g. Bitget, KuCoin).
      if (ack.exchangeOrderId) {
        s.entryExchangeOrderId = ack.exchangeOrderId
        byEntryExchangeOrderId.set(ack.exchangeOrderId, intent.id)
      }
      const entryPlaced: OrderPlacedEvent = {
        intentId: intent.id,
        exchange: intent.exchange,
        symbol: intent.symbol,
        clientOrderId,
        kind: 'entry',
        side: entrySide,
        orderType: 'market',
        qty: check.qty,
        reduceOnly: false,
        ...(ack.exchangeOrderId ? { exchangeOrderId: ack.exchangeOrderId } : {}),
      }
      bus.emit('order.placed', entryPlaced)
      logger.info({ event: 'order.placed', ...entryPlaced }, 'order.placed')

      // Only advance to acked/working if the WS handler hasn't already advanced
      // the state further (e.g. a market order that fills during the REST call).
      if (s.status === 'submitted') transition(s, 'acked')
      if (s.status === 'acked') transition(s, 'working')

      // Catch-up: in case a WS event arrived while the REST call was in flight
      // (market orders on OKX/Bitget/KuCoin fill immediately and emit WS with empty
      // clientOrderId before byEntryExchangeOrderId is registered).
      // Search by clientOrderId first, then exchangeOrderId from the ACK.
      if (!TERMINAL.has(s.status) && s.status === 'working') {
        const existing = opts.state
          .orders(intent.exchange)
          .find(
            o =>
              o.clientOrderId === clientOrderId ||
              (ack.exchangeOrderId !== '' && o.exchangeOrderId === ack.exchangeOrderId)
          )
        if (existing) {
          handleEntryOrderEvent(s, existing)
        }
      }

      // REST polling fallback: if WS fill event doesn't arrive (e.g. Bitget/KuCoin WS
      // unreliable for market-order fills), poll REST until confirmed or intent exits working.
      if (!TERMINAL.has(s.status) && s.status === 'working') {
        void pollForEntryFill(s, clientOrderId, ack.exchangeOrderId, rest)
      }

      return s
    },

    async cancelIntent(id: string): Promise<void> {
      const s = intentStates.get(id)
      if (!s || TERMINAL.has(s.status)) return

      const rest = restAdapters.get(s.intent.exchange)
      if (!rest) return

      if (s.status === 'monitoring' || s.status === 'filled') {
        // Position is open — route to monitor exit via kill_switch reason
        monitor.disarm(id)
        await handleMonitorExit(s, 'kill_switch')
        return
      }

      if (s.entryOrderId && ['submitted', 'acked', 'working', 'partially_filled'].includes(s.status)) {
        try {
          await rest.cancelOrder({
            symbol: s.intent.exchangeSymbol,
            clientOrderId: s.entryOrderId,
          })
        } catch (err) {
          logger.warn({ intentId: id, err }, 'manager: cancelOrder failed')
        }
      }

      // If the entry order had already partially filled, close the open position before going terminal
      if (s.filledQty > 0) {
        await handleMonitorExit(s, 'kill_switch')
        return
      }

      transition(s, 'cancelled')
    },

    async flattenAll(): Promise<void> {
      logger.warn('flattenAll called')

      // Cancel all non-terminal intents
      const toCancel = [...intentStates.values()].filter(s => !TERMINAL.has(s.status))
      await Promise.allSettled(
        toCancel.map(async s => {
          try {
            await this.cancelIntent(s.intent.id)
          } catch (err) {
            logger.warn({ intentId: s.intent.id, err }, 'manager: flattenAll cancel failed')
          }
        })
      )

      // Market close any open positions in state store
      for (const [exchange, rest] of restAdapters) {
        const positions = opts.state.positions(exchange)
        await Promise.allSettled(
          positions
            .filter(p => p.qty > 0)
            .map(async p => {
              const closeId = ids.forExit(`flatten-${exchange}-${p.symbol}-${String(clock.now())}`, 'close')
              const side: OrderSide = p.side === 'long' ? 'sell' : 'buy'
              try {
                await rest.createOrder({
                  intentId: 'flatten',
                  clientOrderId: closeId,
                  exchange,
                  symbol: p.symbol,
                  side,
                  type: 'market',
                  qty: p.qty,
                  reduceOnly: true,
                })
              } catch (err) {
                logger.error({ exchange, symbol: p.symbol, err }, 'manager: flattenAll close failed')
              }
            })
        )
      }
    },

    get(intentId: string): IntentState | undefined {
      return intentStates.get(intentId)
    },

    onStateChange(listener: (state: IntentState) => void): Unsubscribe {
      stateChangeListeners.add(listener)
      return () => stateChangeListeners.delete(listener)
    },

    prewarmLeverage(exchange: Exchange, symbol: string, leverage: number): void {
      const rest = restAdapters.get(exchange)
      if (!rest) return
      const market = opts.markets.get(exchange, symbol)
      if (!market) return
      void ensureLeverage(rest, exchange, market.exchangeSymbol, symbol, leverage).catch((err: unknown) =>
        logger.warn({ event: 'prewarm.leverage_failed', exchange, symbol, leverage, err }, 'prewarmLeverage failed')
      )
    },
  }
}
