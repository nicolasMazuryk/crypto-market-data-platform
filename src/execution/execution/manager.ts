import { createHash } from 'node:crypto'

import type { Logger } from 'pino'

import { normalizeSymbol } from '../../utils/symbol-normalizer.js'
import type {
  Clock,
  EventBus,
  IntentExitedEvent,
  OrderPlacedEvent,
  OrderFilledEvent,
  PositionOpenedEvent,
} from '../core/types.js'
import type { ExecutionIds } from '../core/ids.js'
import type { ExecutionMetrics } from '../observability/metrics.js'
import type { ExchangeRestAdapter, Order, OrderAck, OrderRequest, OrderSide } from '../adapters/rest/types.js'
import type { ExchangeOrderWsAdapter } from '../adapters/orderws/types.js'
import type { StateStore } from '../state/types.js'
import type { MarketMetadataProvider } from '../markets/types.js'
import type { KillSwitch } from '../risk/types.js'
import type { Exchange, Unsubscribe } from '../types/exchange.js'
import type { TradeIntent } from '../strategies/types.js'
import type {
  ExecutionManager,
  ExitOrderRef,
  TerminalMarker,
  IntentState,
  IntentStatus,
  LadderRung,
  PositionMonitor,
} from './types.js'
import type { PreflightResult } from './preflight.js'
import type { RiskConfig } from '../config/types.js'
import { logFundingGateClosed, logFundingGateOpened } from '../observability/log-events.js'
import { alignToLotStep, meetsMinNotional } from '../strategies/shared/sizing.js'

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
  kind: 'entry' | 'pre_funding' | 'sl' | 'tp' | 'close' | 'timed'
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
  /** WS order adapters keyed by exchange — used for strategy_1_ws instead of REST. */
  orderWsAdapters?: Map<Exchange, ExchangeOrderWsAdapter>
  /** Minimum gap (ms) between consecutive entry createOrder calls per exchange.
   *  Prevents rate-limit exhaustion when multiple intents evaluate at the same T_funding.
   *  Single-symbol cycles are unaffected (no prior submission to wait for). */
  submissionStaggerMs?: Partial<Record<Exchange, number>>
  /** strategy_6 shadow validation phase (§6.2.1): stub the real adapter at the order-submission
   *  choke point and synthesize ACK/fill so the state machine + timeline logging run log-only. */
  strategy6ShadowMode?: boolean
}

export interface ExecutionManagerHandle extends ExecutionManager {
  start(): void
  stop(): void
  list(): IntentState[]
}

export function createExecutionManager(opts: ExecutionManagerOptions): ExecutionManagerHandle {
  const { bus, clock, ids, logger, metrics, restAdapters, monitor, preflight, refPrice } = opts

  function requiresWsOrderAdapter(strategy: string): boolean {
    return strategy === 'strategy_1_ws' || strategy === 'strategy_2' || strategy === 'strategy_6'
  }

  // Returns the WS order adapter for strategies that require low-latency WS order placement.
  // Throws if the adapter is missing so failures surface immediately rather than silently degrading to REST.
  function orderClient(exchange: Exchange, strategy: string): Pick<ExchangeRestAdapter, 'createOrder'> {
    if (requiresWsOrderAdapter(strategy)) {
      const ws = opts.orderWsAdapters?.get(exchange)
      if (ws) return ws
      throw new Error(`no WS order adapter for exchange: ${exchange} (strategy ${strategy} requires WS placement)`)
    }
    const rest = restAdapters.get(exchange)
    if (!rest) throw new Error(`no adapter for exchange: ${exchange}`)
    return rest
  }

  // strategy_6 shadow validation phase (§6.2.1): stub the real adapter at this choke point —
  // the entry-order call site (PRE_FUNDING, MAIN) — so those never reach the exchange while the
  // state machine still runs and produces the calibration timeline off a synthetic ACK + fill.
  // SL/TP exit legs are placed via `rest.createOrder` directly (unaffected by this flag) since
  // the validation protocol (§6.2) only concerns the causally-gated entry path.
  function shadowCreateOrder(req: OrderRequest): OrderAck {
    const now = clock.now()
    const exchangeOrderId = `shadow-${req.clientOrderId}`
    logger.info({ event: 'strategy6.shadow.order', ...req }, 'strategy6.shadow.order')
    const ack: OrderAck = { clientOrderId: req.clientOrderId, exchangeOrderId, status: 'accepted', submittedAt: now, ackedAt: now }
    const fillDelayMs = 150
    setTimeout(() => {
      const price = req.price ?? refPrice(req.exchange, req.symbol) ?? 0
      bus.emit('ws.order', {
        exchange: req.exchange,
        seq: 0,
        receivedAt: clock.now(),
        order: {
          exchange: req.exchange,
          symbol: req.symbol,
          clientOrderId: req.clientOrderId,
          exchangeOrderId,
          side: req.side,
          type: req.type,
          qty: req.qty,
          filledQty: req.qty,
          avgFillPrice: price,
          reduceOnly: req.reduceOnly ?? false,
          status: 'filled',
          submittedAt: now,
          updatedAt: clock.now(),
        },
      })
    }, fillDelayMs)
    return ack
  }

  async function createOrderWithOkxWsFallback(strategy: string, req: OrderRequest): Promise<OrderAck> {
    if (strategy === 'strategy_6' && opts.strategy6ShadowMode) return shadowCreateOrder(req)
    const ack = await orderClient(req.exchange, strategy).createOrder(req)
    if (
      req.exchange === 'okx' &&
      requiresWsOrderAdapter(strategy) &&
      ack.status === 'rejected' &&
      (ack.rejectReason ?? '').includes('WS_TIMEOUT')
    ) {
      const rest = restAdapters.get(req.exchange)
      if (!rest) return ack
      logger.warn(
        {
          event: 'okx.ws_timeout_rest_fallback',
          intentId: req.intentId,
          clientOrderId: req.clientOrderId,
          symbol: req.symbol,
          type: req.type,
          reduceOnly: req.reduceOnly,
        },
        'okx.ws_timeout_rest_fallback'
      )
      return rest.createOrder(req)
    }
    return ack
  }

  const intentStates: Map<string, IntentState> = opts.initialState?.intentStates ?? new Map<string, IntentState>()
  // clientOrderId → intentId for entry orders
  const byEntryOrderId: Map<string, string> = opts.initialState?.byEntryOrderId ?? new Map<string, string>()
  // exchangeOrderId → intentId for entry orders (fallback when clientOrderId absent in WS, e.g. Bitget/KuCoin market fills)
  const byEntryExchangeOrderId: Map<string, string> =
    opts.initialState?.byEntryExchangeOrderId ?? new Map<string, string>()
  // clientOrderId → intentId for market-close orders (timed/deadline/kill_switch)
  const byCloseOrderId: Map<string, string> = opts.initialState?.byCloseOrderId ?? new Map<string, string>()
  // exchangeOrderId → intentId for market-close orders (fallback)
  const byCloseExchangeOrderId: Map<string, string> =
    opts.initialState?.byCloseExchangeOrderId ?? new Map<string, string>()
  // (exchange, symbol, leverage) → already-set flag
  const leverageSet = new Set<string>()
  // single-flight: prevents duplicate concurrent setLeverage calls for the same key
  const leverageInFlight = new Map<string, Promise<void>>()

  const stateChangeListeners = new Set<(state: IntentState) => void>()
  const busUnsubs: Unsubscribe[] = []
  // Track entry fill timestamps per intentId for exit latency metric
  const entryFilledAt = new Map<string, number>()
  // intentId → callback invoked by handleEntryOrderEvent's ladder branch on every rung fill.
  // Lets spawnLadderTracker (R11 lifecycle) arm/re-place the TP without the fill handler
  // needing to know about ladder-tracker internals.
  const ladderFillListeners = new Map<string, () => void>()

  // Per-exchange promise chain for serialising concurrent entry createOrder calls.
  // Prevents rate-limit exhaustion when multiple intents evaluate at the same T_funding.
  // Single-symbol cycles acquire immediately (no predecessor in the chain).
  const submissionTails = new Map<Exchange, Promise<void>>()

  function withSubmissionGate<T>(exchange: Exchange, fn: () => Promise<T>): Promise<T> {
    const staggerMs = opts.submissionStaggerMs?.[exchange] ?? 0
    if (staggerMs <= 0) return fn()

    // Read and set tail synchronously — JS single-threaded guarantee ensures concurrent
    // callers from separate async tasks chain correctly between microtask boundaries.
    const prev = submissionTails.get(exchange) ?? Promise.resolve()
    let releaseGate!: () => void
    const gate = new Promise<void>(r => {
      releaseGate = r
    })
    submissionTails.set(exchange, gate)

    // Chain fn after prev completes. Errors in prev don't block us.
    const p = prev
      .catch(() => {
        /* noop */
      })
      .then(() => fn())
    // Hold gate for staggerMs after fn settles so next submission waits the full gap.
    void p
      .then(() => {
        setTimeout(releaseGate, staggerMs)
      })
      .catch(() => {
        releaseGate()
      })
    return p
  }

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

  function ackRejectReason(
    result: PromiseSettledResult<{ status: 'accepted' | 'rejected'; rejectReason?: string }>
  ): string | undefined {
    if (result.status === 'rejected') return String(result.reason)
    if (result.value.status === 'rejected') return result.value.rejectReason ?? 'order rejected'
    return undefined
  }

  async function confirmedCloseQty(s: IntentState, rest: ExchangeRestAdapter): Promise<number> {
    if (s.intent.strategy !== 'strategy_6') return s.filledQty
    try {
      const positions = await rest.getPositions(s.intent.exchangeSymbol)
      const pos = positions.find(p => p.symbol === s.intent.symbol || p.symbol === s.intent.exchangeSymbol)
      if (pos && pos.qty > 0) return pos.qty
      logger.warn(
        { event: 'strategy6.close_position_not_found', intentId: s.intent.id, fallbackQty: s.filledQty },
        'strategy6: close position not found, falling back to tracked fills'
      )
    } catch (err) {
      logger.warn(
        { event: 'strategy6.close_position_fetch_failed', intentId: s.intent.id, err },
        'strategy6: close position fetch failed, falling back to tracked fills'
      )
    }
    const preFundingQty =
      s.preFundingFilledQty ??
      (s.intent.entryPolicy?.kind === 'pre_funding_then_main' ? s.intent.entryPolicy.preFundingVolume : 0)
    return Math.max(0, s.filledQty - preFundingQty) || s.filledQty
  }

  async function closeAfterProtectionFailure(
    s: IntentState,
    code: string,
    message: string,
    placedRefs: ExitOrderRef[]
  ): Promise<void> {
    const rest = restAdapters.get(s.intent.exchange)
    if (!rest) {
      setError(s, 'no_adapter', 'no rest adapter for protective close')
      return
    }

    for (const ref of placedRefs) {
      const cancelled = await rest
        .cancelOrder({
          symbol: s.intent.exchangeSymbol,
          clientOrderId: ref.clientOrderId,
          ...(ref.exchangeOrderId ? { exchangeOrderId: ref.exchangeOrderId } : {}),
        })
        .then(() => true)
        .catch((err: unknown) => {
          logger.warn(
            { intentId: s.intent.id, clientOrderId: ref.clientOrderId, err },
            'protective failure cancel failed'
          )
          return false
        })
      if (cancelled) {
        const now = clock.now()
        bus.emit('ws.order', {
          exchange: s.intent.exchange,
          seq: 0,
          receivedAt: now,
          order: {
            exchange: s.intent.exchange,
            symbol: s.intent.exchangeSymbol,
            clientOrderId: ref.clientOrderId,
            exchangeOrderId: ref.exchangeOrderId ?? '',
            side: s.intent.side === 'long' ? 'sell' : 'buy',
            type: 'limit',
            qty: 0,
            filledQty: 0,
            reduceOnly: true,
            status: 'cancelled',
            submittedAt: now,
            updatedAt: now,
          },
        })
      }
    }

    const closeId = ids.forExit(s.intent.id, 'close')
    const canonCloseId = canonicalize(s.intent.exchange, closeId)
    const exitSide: OrderSide = s.intent.side === 'long' ? 'sell' : 'buy'
    const closeQty = await confirmedCloseQty(s, rest)
    s.exitReason = 'error'
    s.exitOrderRefs = { ...s.exitOrderRefs, close: { clientOrderId: closeId } }
    byCloseOrderId.set(canonCloseId, s.intent.id)

    const closePlacedPre: OrderPlacedEvent = {
      intentId: s.intent.id,
      exchange: s.intent.exchange,
      symbol: s.intent.symbol,
      clientOrderId: closeId,
      kind: 'close',
      side: exitSide,
      orderType: 'market',
      qty: closeQty,
      reduceOnly: true,
      ackPending: true,
    }
    if (opts.beforeCreateOrder) {
      await opts
        .beforeCreateOrder({
          intentId: s.intent.id,
          clientOrderId: closeId,
          exchange: s.intent.exchange,
          symbol: s.intent.exchangeSymbol,
          side: exitSide,
          kind: 'close',
          orderType: 'market',
          qty: closeQty,
          reduceOnly: true,
        })
        .catch((err: unknown) => {
          logger.warn({ intentId: s.intent.id, err }, 'manager: durability write failed for protective close')
        })
    }

    bus.emit('order.placed', closePlacedPre)
    logger.error({ event: 'protective.close_placed', code, ...closePlacedPre }, 'protective.close_placed')

    try {
      const ack = await rest.createOrder({
        intentId: s.intent.id,
        clientOrderId: closeId,
        exchange: s.intent.exchange,
        symbol: s.intent.exchangeSymbol,
        side: exitSide,
        type: 'market',
        qty: closeQty,
        reduceOnly: true,
      })
      if (ack.status === 'accepted') {
        if (ack.exchangeOrderId) {
          byCloseExchangeOrderId.set(ack.exchangeOrderId, s.intent.id)
          s.exitOrderRefs = {
            ...s.exitOrderRefs,
            close: { clientOrderId: closeId, exchangeOrderId: ack.exchangeOrderId },
          }
          bus.emit('order.placed', { ...closePlacedPre, exchangeOrderId: ack.exchangeOrderId, ackPending: false })
        }
        if (!TERMINAL.has(s.status)) {
          transition(s, 'exiting')
          void pollForCloseFill(s, closeId, ack.exchangeOrderId, rest, () => {
            setError(s, code, message)
          })
        }
      } else {
        logger.error(
          { intentId: s.intent.id, code, rejectReason: ack.rejectReason },
          'protective market close rejected'
        )
        byCloseOrderId.delete(canonCloseId)
        setError(s, code, message)
      }
    } catch (err) {
      logger.error({ intentId: s.intent.id, code, err }, 'protective market close failed')
      byCloseOrderId.delete(canonCloseId)
      setError(s, code, message)
    }

    metrics.intentRejectedTotal.inc(1, { exchange: s.intent.exchange, strategy: s.intent.strategy, code })
    bus.emit('ops.event', {
      ts: clock.now(),
      level: 'error',
      exchange: s.intent.exchange,
      eventType: 'protective_order_failure_close',
      payload: { intentId: s.intent.id, code, message },
    })
  }

  async function handleEntryFilled(s: IntentState): Promise<void> {
    const { intent } = s
    const rest = restAdapters.get(intent.exchange)
    if (!rest) {
      setError(s, 'no_adapter', 'no rest adapter for entry fills')
      return
    }

    if (
      intent.exitPolicy.kind === 'sl_tp_deadline_retracement' ||
      intent.exitPolicy.kind === 'sl_tp_deadline_retracement_funding_event'
    ) {
      // Place SL immediately; TP is placed dynamically by the retracement tracker after T_funding.
      const slId = ids.forExit(intent.id, 'sl')
      const exitSide: OrderSide = intent.side === 'long' ? 'sell' : 'buy'
      const { slPct } = intent.exitPolicy
      const price = s.avgEntryPrice ?? refPrice(intent.exchange, intent.symbol) ?? 0

      if (price > 0) {
        const slPrice = intent.side === 'long' ? price * (1 - slPct / 100) : price * (1 + slPct / 100)
        const exitQty = intent.volume

        if (opts.beforeCreateOrder) {
          await opts
            .beforeCreateOrder({
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
            })
            .catch((err: unknown) => {
              logger.warn({ intentId: intent.id, err }, 'manager: durability write failed for sl order (retracement)')
              bus.emit('ops.event', {
                ts: clock.now(),
                level: 'fatal',
                exchange: intent.exchange,
                eventType: 'durability_write_failed',
                payload: { intentId: intent.id, kind: 'sl', err: String(err) },
              })
            })
        }

        try {
          const slResult = await rest.createOrder({
            intentId: intent.id,
            clientOrderId: slId,
            exchange: intent.exchange,
            symbol: intent.exchangeSymbol,
            side: exitSide,
            type: 'stop_market',
            qty: exitQty,
            stopPrice: slPrice,
            reduceOnly: true,
          })
          if (slResult.status === 'rejected') {
            const rejectNow = clock.now()
            bus.emit('ws.order', {
              exchange: intent.exchange,
              seq: 0,
              receivedAt: rejectNow,
              order: {
                exchange: intent.exchange,
                symbol: intent.exchangeSymbol,
                clientOrderId: slId,
                exchangeOrderId: slResult.exchangeOrderId,
                side: exitSide,
                type: 'stop_market',
                qty: exitQty,
                filledQty: 0,
                reduceOnly: true,
                status: 'rejected',
                ...(slResult.rejectReason !== undefined ? { rejectReason: slResult.rejectReason } : {}),
                submittedAt: rejectNow,
                updatedAt: rejectNow,
              },
            })
            await closeAfterProtectionFailure(
              s,
              'retracement_sl_rejected',
              slResult.rejectReason ?? 'retracement SL rejected',
              []
            )
            return
          }
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
            ...(slResult.exchangeOrderId ? { exchangeOrderId: slResult.exchangeOrderId } : {}),
          }
          bus.emit('order.placed', slPlaced)
          logger.info({ event: 'order.placed', ...slPlaced }, 'order.placed')
          s.exitOrderRefs = {
            sl: {
              clientOrderId: canonicalize(intent.exchange, slId),
              ...(slResult.exchangeOrderId ? { exchangeOrderId: slResult.exchangeOrderId } : {}),
            },
          }
        } catch (err) {
          logger.warn({ intentId: intent.id, err }, 'manager: sl order placement failed (retracement)')
          await closeAfterProtectionFailure(s, 'retracement_sl_failed', String(err), [])
          return
        }
      } else {
        logger.warn(
          { event: 'handleEntryFilled.no_price', intentId: intent.id },
          'handleEntryFilled: zero ref price — SL not placed for retracement intent'
        )
        await closeAfterProtectionFailure(s, 'retracement_sl_no_price', 'zero ref price for retracement SL', [])
        return
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
      // Spawn the retracement TP tracker — runs concurrently alongside the SL/deadline monitor.
      spawnRetracementTracker(s)
      return
    }

    if (intent.exitPolicy.kind === 'sl_tp_deadline') {
      const slId = ids.forExit(intent.id, 'sl')
      const tpId = ids.forExit(intent.id, 'tp')
      const exitSide: OrderSide = intent.side === 'long' ? 'sell' : 'buy'
      const { slPct, tpPct } = intent.exitPolicy
      let price = s.avgEntryPrice ?? refPrice(intent.exchange, intent.symbol) ?? 0

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
        await closeAfterProtectionFailure(s, 'protective_no_price', 'zero ref price for SL/TP placement', [])
        return
      }
      if (price > 0) {
        // Size SL/TP to full intended volume so late incremental fills are hedged.
        // The exchange will clamp reduceOnly orders to the actual position size.
        let exitQty = intent.volume
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
            // Anchor prices to the exchange-reported entry price when position is oversized.
            if (pos.entryPrice !== undefined && pos.entryPrice > 0) {
              price = pos.entryPrice
            }
          }
        } catch (err) {
          logger.warn(
            { intentId: intent.id, err },
            'handleEntryFilled: getPositions failed — using intent.volume for SL/TP'
          )
        }

        // R11: SL anchors to P_limit for single-limit entries (precomputable at placement);
        // TP stays anchored to the fill price. strategy_3 (market entry, no entryPolicy) and
        // strategy_4_1a (ladder_limit, handled via spawnLadderTracker) are unaffected.
        const slAnchor =
          intent.entryPolicy?.kind === 'limit' && s.entryLimitPrice !== undefined ? s.entryLimitPrice : price
        const slPrice = intent.side === 'long' ? slAnchor * (1 - slPct / 100) : slAnchor * (1 + slPct / 100)
        const tpPrice = intent.side === 'long' ? price * (1 + tpPct / 100) : price * (1 - tpPct / 100)

        if (opts.beforeCreateOrder) {
          await Promise.all([
            opts
              .beforeCreateOrder({
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
              })
              .catch((err: unknown) => {
                logger.warn({ intentId: intent.id, err }, 'manager: durability write failed for sl order')
                bus.emit('ops.event', {
                  ts: clock.now(),
                  level: 'fatal',
                  exchange: intent.exchange,
                  eventType: 'durability_write_failed',
                  payload: { intentId: intent.id, kind: 'sl', err: String(err) },
                })
              }),
            opts
              .beforeCreateOrder({
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
              })
              .catch((err: unknown) => {
                logger.warn({ intentId: intent.id, err }, 'manager: durability write failed for tp order')
                bus.emit('ops.event', {
                  ts: clock.now(),
                  level: 'fatal',
                  exchange: intent.exchange,
                  eventType: 'durability_write_failed',
                  payload: { intentId: intent.id, kind: 'tp', err: String(err) },
                })
              }),
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

        const slReject = ackRejectReason(slResult)
        const tpReject = ackRejectReason(tpResult)
        const placedRefs: ExitOrderRef[] = []
        if (!slReject && slResult.status === 'fulfilled') {
          placedRefs.push({
            clientOrderId: canonicalize(intent.exchange, slId),
            ...(slResult.value.exchangeOrderId ? { exchangeOrderId: slResult.value.exchangeOrderId } : {}),
          })
        }
        if (!tpReject && tpResult.status === 'fulfilled') {
          placedRefs.push({
            clientOrderId: canonicalize(intent.exchange, tpId),
            ...(tpResult.value.exchangeOrderId ? { exchangeOrderId: tpResult.value.exchangeOrderId } : {}),
          })
        }
        // Emit synthetic ws.order for any rejected protective order so the DB row leaves status=new.
        const rejectNow = clock.now()
        if (slReject && slResult.status === 'fulfilled' && slResult.value.status === 'rejected') {
          bus.emit('ws.order', {
            exchange: intent.exchange,
            seq: 0,
            receivedAt: rejectNow,
            order: {
              exchange: intent.exchange,
              symbol: intent.exchangeSymbol,
              clientOrderId: slId,
              exchangeOrderId: slResult.value.exchangeOrderId,
              side: exitSide,
              type: 'stop_market',
              qty: exitQty,
              filledQty: 0,
              reduceOnly: true,
              status: 'rejected',
              ...(slResult.value.rejectReason !== undefined ? { rejectReason: slResult.value.rejectReason } : {}),
              submittedAt: rejectNow,
              updatedAt: rejectNow,
            },
          })
        }
        if (tpReject && tpResult.status === 'fulfilled' && tpResult.value.status === 'rejected') {
          bus.emit('ws.order', {
            exchange: intent.exchange,
            seq: 0,
            receivedAt: rejectNow,
            order: {
              exchange: intent.exchange,
              symbol: intent.exchangeSymbol,
              clientOrderId: tpId,
              exchangeOrderId: tpResult.value.exchangeOrderId,
              side: exitSide,
              type: 'limit',
              qty: exitQty,
              filledQty: 0,
              reduceOnly: true,
              status: 'rejected',
              ...(tpResult.value.rejectReason !== undefined ? { rejectReason: tpResult.value.rejectReason } : {}),
              submittedAt: rejectNow,
              updatedAt: rejectNow,
            },
          })
        }
        if (slReject || tpReject) {
          logger.error({ intentId: intent.id, slReject, tpReject }, 'manager: protective order placement failed')
          await closeAfterProtectionFailure(
            s,
            'protective_order_failed',
            `SL/TP placement failed: sl=${slReject ?? 'accepted'} tp=${tpReject ?? 'accepted'}`,
            placedRefs
          )
          return
        }

        const slExchangeOrderId = slResult.status === 'fulfilled' ? slResult.value.exchangeOrderId : undefined
        const tpExchangeOrderId = tpResult.status === 'fulfilled' ? tpResult.value.exchangeOrderId : undefined
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
          ...(slExchangeOrderId ? { exchangeOrderId: slExchangeOrderId } : {}),
        }
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
          ...(tpExchangeOrderId ? { exchangeOrderId: tpExchangeOrderId } : {}),
        }
        bus.emit('order.placed', slPlaced)
        bus.emit('order.placed', tpPlaced)
        logger.info({ event: 'order.placed', ...slPlaced }, 'order.placed')
        logger.info({ event: 'order.placed', ...tpPlaced }, 'order.placed')
        s.exitOrderRefs = {
          ...s.exitOrderRefs,
          sl: {
            clientOrderId: canonicalize(intent.exchange, slId),
            ...(slExchangeOrderId ? { exchangeOrderId: slExchangeOrderId } : {}),
          },
          tp: {
            clientOrderId: canonicalize(intent.exchange, tpId),
            ...(tpExchangeOrderId ? { exchangeOrderId: tpExchangeOrderId } : {}),
          },
        }
      }
    }

    if (intent.exitPolicy.kind === 'sl_tp_deadline_post_funding_event') {
      // Place SL + TP immediately after MAIN fill. Net exit qty = mainVolume − preFundingVolume.
      const slId = ids.forExit(intent.id, 'sl')
      const tpId = ids.forExit(intent.id, 'tp')
      const exitSide: OrderSide = intent.side === 'long' ? 'sell' : 'buy'
      const { tpMultiplier, slMultiplier } = intent.exitPolicy
      const price = s.avgEntryPrice ?? refPrice(intent.exchange, intent.symbol) ?? 0
      if (s.settledFundingRatePercent === undefined) {
        logger.warn(
          {
            event: 'strategy6.settled_rate_fallback',
            intentId: intent.id,
            intentFundingRatePercent: intent.fundingRatePercent,
          },
          'strategy6: settled funding rate unavailable at MAIN fill, falling back to intent.fundingRatePercent'
        )
      }
      const absF = Math.abs(s.settledFundingRatePercent ?? intent.fundingRatePercent)

      const preFundingVolume =
        s.preFundingFilledQty ??
        (intent.entryPolicy?.kind === 'pre_funding_then_main' ? intent.entryPolicy.preFundingVolume : 0)
      let exitQty = Math.max(0, s.filledQty - preFundingVolume)
      try {
        const positions = await rest.getPositions(intent.exchangeSymbol)
        const pos = positions.find(p => p.symbol === intent.symbol || p.symbol === intent.exchangeSymbol)
        if (pos && pos.qty > 0) {
          exitQty = pos.qty
        } else {
          logger.warn(
            { event: 'strategy6.position_not_found', intentId: intent.id, fallbackQty: exitQty },
            'strategy6: confirmed position not found, falling back to tracked fills'
          )
        }
      } catch (err) {
        logger.warn(
          { event: 'strategy6.position_fetch_failed', intentId: intent.id, err, fallbackQty: exitQty },
          'strategy6: position fetch failed, falling back to tracked fills'
        )
      }

      if (price > 0 && exitQty > 0) {
        const tpPct = absF * tpMultiplier
        const slPct = absF * slMultiplier
        const tpPrice = intent.side === 'long' ? price * (1 + tpPct / 100) : price * (1 - tpPct / 100)
        const slPrice = intent.side === 'long' ? price * (1 - slPct / 100) : price * (1 + slPct / 100)

        if (opts.beforeCreateOrder) {
          await Promise.all([
            opts
              .beforeCreateOrder({
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
              })
              .catch((err: unknown) => {
                logger.warn({ intentId: intent.id, err }, 'manager: durability write failed for sl (post_funding)')
                bus.emit('ops.event', {
                  ts: clock.now(),
                  level: 'fatal',
                  exchange: intent.exchange,
                  eventType: 'durability_write_failed',
                  payload: { intentId: intent.id, kind: 'sl', err: String(err) },
                })
              }),
            opts
              .beforeCreateOrder({
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
              })
              .catch((err: unknown) => {
                logger.warn({ intentId: intent.id, err }, 'manager: durability write failed for tp (post_funding)')
                bus.emit('ops.event', {
                  ts: clock.now(),
                  level: 'fatal',
                  exchange: intent.exchange,
                  eventType: 'durability_write_failed',
                  payload: { intentId: intent.id, kind: 'tp', err: String(err) },
                })
              }),
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

        const slReject = ackRejectReason(slResult)
        const tpReject = ackRejectReason(tpResult)
        const placedRefs: ExitOrderRef[] = []
        if (!slReject && slResult.status === 'fulfilled') {
          placedRefs.push({
            clientOrderId: canonicalize(intent.exchange, slId),
            ...(slResult.value.exchangeOrderId ? { exchangeOrderId: slResult.value.exchangeOrderId } : {}),
          })
        }
        if (!tpReject && tpResult.status === 'fulfilled') {
          placedRefs.push({
            clientOrderId: canonicalize(intent.exchange, tpId),
            ...(tpResult.value.exchangeOrderId ? { exchangeOrderId: tpResult.value.exchangeOrderId } : {}),
          })
        }
        // Emit synthetic ws.order for any rejected protective order so the DB row leaves status=new.
        const rejectNowPf = clock.now()
        if (slReject && slResult.status === 'fulfilled' && slResult.value.status === 'rejected') {
          bus.emit('ws.order', {
            exchange: intent.exchange,
            seq: 0,
            receivedAt: rejectNowPf,
            order: {
              exchange: intent.exchange,
              symbol: intent.exchangeSymbol,
              clientOrderId: slId,
              exchangeOrderId: slResult.value.exchangeOrderId,
              side: exitSide,
              type: 'stop_market',
              qty: exitQty,
              filledQty: 0,
              reduceOnly: true,
              status: 'rejected',
              ...(slResult.value.rejectReason !== undefined ? { rejectReason: slResult.value.rejectReason } : {}),
              submittedAt: rejectNowPf,
              updatedAt: rejectNowPf,
            },
          })
        }
        if (tpReject && tpResult.status === 'fulfilled' && tpResult.value.status === 'rejected') {
          bus.emit('ws.order', {
            exchange: intent.exchange,
            seq: 0,
            receivedAt: rejectNowPf,
            order: {
              exchange: intent.exchange,
              symbol: intent.exchangeSymbol,
              clientOrderId: tpId,
              exchangeOrderId: tpResult.value.exchangeOrderId,
              side: exitSide,
              type: 'limit',
              qty: exitQty,
              filledQty: 0,
              reduceOnly: true,
              status: 'rejected',
              ...(tpResult.value.rejectReason !== undefined ? { rejectReason: tpResult.value.rejectReason } : {}),
              submittedAt: rejectNowPf,
              updatedAt: rejectNowPf,
            },
          })
        }
        if (slReject || tpReject) {
          logger.error(
            { intentId: intent.id, slReject, tpReject },
            'manager: post-funding protective order placement failed'
          )
          await closeAfterProtectionFailure(
            s,
            'post_funding_protective_order_failed',
            `post-funding SL/TP placement failed: sl=${slReject ?? 'accepted'} tp=${tpReject ?? 'accepted'}`,
            placedRefs
          )
          return
        }

        const slExchangeOrderId = slResult.status === 'fulfilled' ? slResult.value.exchangeOrderId : undefined
        const tpExchangeOrderId = tpResult.status === 'fulfilled' ? tpResult.value.exchangeOrderId : undefined
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
          ...(slExchangeOrderId ? { exchangeOrderId: slExchangeOrderId } : {}),
        }
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
          ...(tpExchangeOrderId ? { exchangeOrderId: tpExchangeOrderId } : {}),
        }
        bus.emit('order.placed', slPlaced)
        bus.emit('order.placed', tpPlaced)
        logger.info({ event: 'order.placed', ...slPlaced }, 'order.placed')
        logger.info({ event: 'order.placed', ...tpPlaced }, 'order.placed')
        s.exitOrderRefs = {
          ...s.exitOrderRefs,
          sl: {
            clientOrderId: canonicalize(intent.exchange, slId),
            ...(slExchangeOrderId ? { exchangeOrderId: slExchangeOrderId } : {}),
          },
          tp: {
            clientOrderId: canonicalize(intent.exchange, tpId),
            ...(tpExchangeOrderId ? { exchangeOrderId: tpExchangeOrderId } : {}),
          },
        }
      } else {
        logger.warn(
          { event: 'handleEntryFilled.no_price_or_qty', intentId: intent.id, price, exitQty },
          'handleEntryFilled: zero price or qty — SL/TP not placed for post_funding intent'
        )
        await closeAfterProtectionFailure(
          s,
          'post_funding_protective_no_price_or_qty',
          'zero price or qty for post-funding SL/TP',
          []
        )
        return
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
    // REST fallback: poll for SL/TP fills in case WS events are missed (e.g. reconnect gap,
    // or Bybit conditional stop orders whose triggered market order doesn't carry the clientOrderId).
    if (s.exitOrderRefs && (s.exitOrderRefs.sl || s.exitOrderRefs.tp)) {
      void pollForSlTpFill(s)
    }
  }

  /**
   * Retracement TP tracker for `sl_tp_deadline_retracement` and
   * `sl_tp_deadline_retracement_funding_event` (strategy_2).
   *
   * Runs concurrently after entry fill. Polls `refPrice` every second, tracks P_low, and
   * places/replaces a TP limit order whenever P_low decreases (throttled to ≤1/s).
   * For the funding_event variant, tracking only begins after ws.funding_fee is received
   * (or the hard timeout fires). On TP fill, cancels SL and drives exit.
   */
  function spawnRetracementTracker(s: IntentState): void {
    const { intent } = s
    if (
      intent.exitPolicy.kind !== 'sl_tp_deadline_retracement' &&
      intent.exitPolicy.kind !== 'sl_tp_deadline_retracement_funding_event'
    )
      return
    const rest = restAdapters.get(intent.exchange)
    if (!rest) return

    const { fundingTs, deadlineAt, retracementPct, anchorPrice } = intent.exitPolicy
    const isFundingEventKind = intent.exitPolicy.kind === 'sl_tp_deadline_retracement_funding_event'
    const timeoutAt =
      intent.exitPolicy.kind === 'sl_tp_deadline_retracement_funding_event' ? intent.exitPolicy.timeoutAt : fundingTs
    const exitSide: OrderSide = intent.side === 'long' ? 'sell' : 'buy'

    // For the funding_event variant, P_low tracking begins only when the WS event fires (or
    // the timeout fallback). For the legacy variant it begins at fundingTs (wall-clock).
    // s.fundingGateOpen is set to true when the gate opens and persisted to DB for restart re-arm.
    let fundingGateOpen = s.fundingGateOpen ?? !isFundingEventKind

    let pLow = Infinity
    let tpVersion = 0
    let currentTpCanonId: string | null = null
    let currentTpUnsub: Unsubscribe | null = null
    let exitUnsub: (() => void) | null = null
    let lastReplaceAt = 0
    let settled = false
    let gateOpenedAt: number | null = null
    let tpPlacementFailures = 0
    const maxTpPlacementFailures = 3

    const cleanup = () => {
      currentTpUnsub?.()
      currentTpUnsub = null
      exitUnsub?.()
      exitUnsub = null
    }

    const settleTp = async (avgFillPrice?: number) => {
      if (settled) return
      settled = true
      cleanup()
      if (avgFillPrice !== undefined) s.avgExitPrice = avgFillPrice
      monitor.disarm(intent.id)
      await handleMonitorExit(s, 'tp_hit')
    }

    const recordTpPlacementFailure = async (reason: string) => {
      tpPlacementFailures++
      if (tpPlacementFailures < maxTpPlacementFailures) return
      if (settled) return
      settled = true
      cleanup()
      bus.emit('ops.event', {
        ts: clock.now(),
        level: 'error',
        exchange: intent.exchange,
        eventType: 'retracement_tp_exhausted',
        payload: { intentId: intent.id, failures: tpPlacementFailures, reason },
      })
      logger.error(
        { event: 'retracement.tp_exhausted', intentId: intent.id, failures: tpPlacementFailures, reason },
        'retracement.tp_exhausted'
      )
      monitor.disarm(intent.id)
      await handleMonitorExit(s, 'error')
    }

    const openFundingGate = (): void => {
      if (fundingGateOpen) return
      fundingGateOpen = true
      gateOpenedAt = clock.now()
      s.fundingGateOpen = true
      bus.emit('intent.funding_gate_opened', { intentId: intent.id })
      logFundingGateOpened(logger, { intentId: intent.id, openedAt: gateOpenedAt, fundingTs })
    }

    // Single-source gate close: catch all exit paths including SL, deadline, timeout, error.
    // Runs for every exit reason — emits exactly one funding_gate_closed per opened gate.
    exitUnsub = bus.on('intent.exited', exitEvent => {
      if (exitEvent.intentId !== intent.id) return
      if (gateOpenedAt !== null) {
        const closedAt = clock.now()
        logFundingGateClosed(logger, {
          intentId: intent.id,
          openedAt: gateOpenedAt,
          closedAt,
          durationMs: closedAt - gateOpenedAt,
          reason: exitEvent.exitReason as Parameters<typeof logFundingGateClosed>[1]['reason'],
        })
      }
      cleanup()
    })

    // Wire up the WS funding-fee gate for the new variant.
    if (isFundingEventKind) {
      const toleranceMs = 5_000
      const feeUnsub = bus.on('ws.funding_fee', event => {
        if (event.exchange !== intent.exchange) return
        if (event.symbol !== intent.symbol) return
        if (event.fundingTime < fundingTs - toleranceMs || event.fundingTime > fundingTs + toleranceMs) return
        openFundingGate()
        feeUnsub()
      })

      const timeoutDelay = Math.max(0, timeoutAt - clock.now())
      setTimeout(() => {
        openFundingGate()
      }, timeoutDelay)
    }

    const replaceTp = async (tpPrice: number) => {
      const now = clock.now()
      if (now - lastReplaceAt < 1000) return
      lastReplaceAt = now

      // Cancel the previous TP limit using exhaustion helper for reliable confirmation.
      // A bare best-effort cancel races with WS replay — cancelSiblingExit verifies via open-orders.
      if (currentTpCanonId) {
        cleanup()
        const currentTpRef: ExitOrderRef = {
          clientOrderId: currentTpCanonId,
          ...(s.exitOrderRefs?.tp?.exchangeOrderId !== undefined
            ? { exchangeOrderId: s.exitOrderRefs.tp.exchangeOrderId }
            : {}),
        }
        const tpCancelResult = await cancelSiblingExit(rest, intent, currentTpRef)
        if (tpCancelResult === 'failed') {
          logger.warn(
            { event: 'retracement.tp_cancel_failed', intentId: intent.id, clientOrderId: currentTpCanonId },
            'retracement tracker: previous TP cancel failed, skipping TP replace this cycle'
          )
          return
        }
      }

      // Cancel the SL order before placing TP. Bybit enforces that the sum of all reduce-only
      // orders cannot exceed the position size. Use cancelSiblingExit to verify the cancel was
      // actually processed before placing TP — a bare REST cancel returns "acknowledged" before
      // the exchange updates the reduce-only quota, causing 110017 on immediate TP placement.
      const slRef = s.exitOrderRefs?.sl
      if (slRef) {
        const cancelResult = await cancelSiblingExit(rest, intent, slRef)
        if (cancelResult !== 'failed') {
          const { sl: _removedSl, ...restRefs } = s.exitOrderRefs ?? {}
          s.exitOrderRefs = restRefs
        } else {
          logger.warn(
            { event: 'retracement.sl_cancel_failed', intentId: intent.id },
            'retracement tracker: SL cancel failed, skipping TP this cycle'
          )
          return
        }
      }

      const tpId = ids.forIntent(intent.id, 100 + tpVersion++)
      const canonTpId = canonicalize(intent.exchange, tpId)
      currentTpCanonId = canonTpId
      s.exitOrderRefs = { ...s.exitOrderRefs, tp: { clientOrderId: canonTpId } }

      // Subscribe to WS fill for this specific TP order.
      currentTpUnsub = bus.on('ws.order', event => {
        if (event.exchange !== intent.exchange) return
        if (event.order.clientOrderId !== canonTpId) return
        if (event.order.status !== 'filled') return
        void settleTp(event.order.avgFillPrice)
      })

      try {
        const exitQty = intent.volume
        const ack = await rest.createOrder({
          intentId: intent.id,
          clientOrderId: tpId,
          exchange: intent.exchange,
          symbol: intent.exchangeSymbol,
          side: exitSide,
          type: 'limit',
          qty: exitQty,
          price: tpPrice,
          reduceOnly: true,
        })
        if (ack.status !== 'accepted') {
          cleanup()
          logger.warn(
            { event: 'retracement.tp_rejected', intentId: intent.id, tpVersion, rejectReason: ack.rejectReason },
            'retracement tracker: TP rejected'
          )
          // "position is zero / empty" means the SL triggered before the retracement window.
          // Settle immediately as an SL exit rather than waiting for the deadline.
          // Bybit: 110017; Gate.io: INCREASE_POSITION "empty position"; Binance: -2022 ReduceOnly rejected
          const rejectReason = ack.rejectReason ?? ''
          const emptyPosition =
            rejectReason.includes('110017') ||
            (rejectReason.includes('INCREASE_POSITION') && rejectReason.includes('empty position')) ||
            rejectReason.includes('-2022')
          if (emptyPosition) {
            settled = true
            monitor.disarm(intent.id)
            await handleMonitorExit(s, 'sl_hit')
            return
          }
          await recordTpPlacementFailure(ack.rejectReason ?? 'TP rejected')
          return
        }
        tpPlacementFailures = 0
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
          ...(ack.exchangeOrderId ? { exchangeOrderId: ack.exchangeOrderId } : {}),
        }
        bus.emit('order.placed', tpPlaced)
        logger.info({ event: 'retracement.tp_placed', ...tpPlaced, tpVersion }, 'retracement.tp_placed')
        if (ack.exchangeOrderId) {
          s.exitOrderRefs = {
            ...s.exitOrderRefs,
            tp: { clientOrderId: canonTpId, exchangeOrderId: ack.exchangeOrderId },
          }
        }
      } catch (err) {
        logger.warn({ intentId: intent.id, tpVersion, err }, 'retracement tracker: TP placement failed')
        await recordTpPlacementFailure(String(err))
      }
    }

    const tick = async () => {
      if (settled || TERMINAL.has(s.status) || s.status !== 'monitoring') {
        cleanup()
        return
      }
      const now = clock.now()
      if (now >= deadlineAt) {
        cleanup()
        return
      }

      // Legacy kind: gate on wall-clock ≥ fundingTs.
      // Funding-event kind: gate on WS event received OR timeout fallback (fundingGateOpen flag).
      const gateOpen = isFundingEventKind ? fundingGateOpen : now >= fundingTs

      if (gateOpen) {
        const currentPrice = refPrice(intent.exchange, intent.symbol)
        if (currentPrice !== undefined && currentPrice < pLow) {
          const pLowOld = pLow
          pLow = currentPrice
          logger.info(
            { event: 'retracement.p_low.update', intentId: intent.id, pLowOld, pLowNew: currentPrice },
            'retracement.p_low.update'
          )
          // Only place TP when price has actually dropped below the anchor.
          if (anchorPrice > pLow) {
            const tpPrice = pLow + (anchorPrice - pLow) * retracementPct
            await replaceTp(tpPrice)
          }
        }
      }

      setTimeout(() => void tick(), 1_000)
    }

    // Begin polling from fundingTs; wait until then if entry fill was early.
    const delayMs = Math.max(0, fundingTs - clock.now())
    setTimeout(() => void tick(), delayMs)
  }

  /**
   * R11 ladder lifecycle tracker for `strategy_4_1a` (ladder_limit entry + sl_tp_deadline exit).
   *
   * The SL is engine-tracked (not a resting exchange order): it is fixed at `pAvgFull` from
   * placement and fires a reduce-only market close on whatever qty is currently filled, the
   * first time price crosses it. Polls `refPrice` every second, gated on `filledQty > 0`.
   *
   * The TP IS a resting reduce-only limit order, placed on the first rung fill and cancelled +
   * re-placed (via `ladderFillListeners`) on each deeper fill at the new fill-weighted average.
   * `monitor.arm` (already armed at placement for the deadline timer) is re-armed after every TP
   * (re)placement so its ws.order watch picks up the new TP clientOrderId.
   *
   * Deadline and TP fills both flow through the existing `monitor` → `handleMonitorExit` path;
   * only the SL trigger and TP arm/re-place are driven from here.
   */
  function spawnLadderTracker(s: IntentState, pAvgFull: number): void {
    const { intent } = s
    if (intent.exitPolicy.kind !== 'sl_tp_deadline') return
    const rest = restAdapters.get(intent.exchange)
    if (!rest) return

    const { slPct, tpPct, deadlineAt } = intent.exitPolicy
    const exitSide: OrderSide = intent.side === 'long' ? 'sell' : 'buy'
    const slPrice = intent.side === 'long' ? pAvgFull * (1 - slPct / 100) : pAvgFull * (1 + slPct / 100)

    let settled = false
    let tpVersion = 0
    let currentTpCanonId: string | null = null
    let tpInFlight = false

    const stopTracking = (): void => {
      settled = true
      ladderFillListeners.delete(intent.id)
    }

    const triggerSl = (): void => {
      if (settled) return
      stopTracking()
      monitor.disarm(intent.id)
      logger.info({ event: 'ladder.sl_triggered', intentId: intent.id, slPrice }, 'ladder.sl_triggered')
      void handleMonitorExit(s, 'sl_hit')
    }

    const replaceLadderTp = async (): Promise<void> => {
      if (settled || tpInFlight) return
      const totalQty = s.filledQty
      const avgPrice = s.avgEntryPrice
      if (totalQty <= 0 || avgPrice === undefined) return
      tpInFlight = true
      try {
        const tpPrice = intent.side === 'long' ? avgPrice * (1 + tpPct / 100) : avgPrice * (1 - tpPct / 100)

        if (currentTpCanonId) {
          const prevRef: ExitOrderRef = {
            clientOrderId: currentTpCanonId,
            ...(s.exitOrderRefs?.tp?.exchangeOrderId !== undefined
              ? { exchangeOrderId: s.exitOrderRefs.tp.exchangeOrderId }
              : {}),
          }
          const cancelResult = await cancelSiblingExit(rest, intent, prevRef)
          if (cancelResult === 'failed') {
            logger.warn(
              { event: 'ladder.tp_cancel_failed', intentId: intent.id, clientOrderId: currentTpCanonId },
              'ladder tracker: previous TP cancel failed, skipping re-place this fill'
            )
            return
          }
        }

        const tpId = ids.forIntent(intent.id, 200 + tpVersion++)
        const canonTpId = canonicalize(intent.exchange, tpId)
        currentTpCanonId = canonTpId

        const ack = await rest.createOrder({
          intentId: intent.id,
          clientOrderId: tpId,
          exchange: intent.exchange,
          symbol: intent.exchangeSymbol,
          side: exitSide,
          type: 'limit',
          qty: totalQty,
          price: tpPrice,
          reduceOnly: true,
        })
        if (ack.status !== 'accepted') {
          logger.warn(
            { event: 'ladder.tp_rejected', intentId: intent.id, rejectReason: ack.rejectReason },
            'ladder tracker: TP rejected'
          )
          return
        }

        const tpPlaced: OrderPlacedEvent = {
          intentId: intent.id,
          exchange: intent.exchange,
          symbol: intent.symbol,
          clientOrderId: tpId,
          kind: 'tp',
          side: exitSide,
          orderType: 'limit',
          qty: totalQty,
          price: tpPrice,
          reduceOnly: true,
          ...(ack.exchangeOrderId ? { exchangeOrderId: ack.exchangeOrderId } : {}),
        }
        bus.emit('order.placed', tpPlaced)
        logger.info({ event: 'ladder.tp_placed', ...tpPlaced, tpVersion }, 'ladder.tp_placed')
        s.exitOrderRefs = {
          ...s.exitOrderRefs,
          tp: { clientOrderId: canonTpId, ...(ack.exchangeOrderId ? { exchangeOrderId: ack.exchangeOrderId } : {}) },
        }
        // Re-arm so monitor's ws.order watch picks up the new TP clientOrderId.
        if (s.status === 'monitoring' || s.status === 'partially_filled') monitor.arm(s)
      } catch (err) {
        logger.warn({ intentId: intent.id, err }, 'ladder tracker: TP placement failed')
      } finally {
        tpInFlight = false
      }
    }

    ladderFillListeners.set(intent.id, () => {
      void replaceLadderTp()
    })

    const tick = (): void => {
      if (settled || TERMINAL.has(s.status) || s.status === 'exiting') {
        stopTracking()
        return
      }
      if (clock.now() >= deadlineAt) {
        // The deadline timer armed via monitor.arm() drives the actual exit; stop polling.
        stopTracking()
        return
      }
      if (s.filledQty > 0) {
        const currentPrice = refPrice(intent.exchange, intent.symbol)
        if (currentPrice !== undefined) {
          const breached = intent.side === 'long' ? currentPrice <= slPrice : currentPrice >= slPrice
          if (breached) {
            triggerSl()
            return
          }
        }
      }
      setTimeout(tick, 1_000)
    }

    // SL is live from placement — check immediately, then poll every second.
    setTimeout(tick, 0)
  }

  async function placeLadderPostErrorProtectiveClose(
    s: IntentState,
    order: { clientOrderId: string; filledQty: number }
  ): Promise<void> {
    const rest = restAdapters.get(s.intent.exchange)
    if (!rest) return
    const closeSide: OrderSide = s.intent.side === 'long' ? 'sell' : 'buy'
    const clientOrderId = createHash('sha256')
      .update(`post_error_close|${s.intent.id}|${order.clientOrderId}`)
      .digest('hex')
      .slice(0, 28)
    logger.warn(
      {
        event: 'ladder.post_error_fill',
        intentId: s.intent.id,
        exchange: s.intent.exchange,
        symbol: s.intent.symbol,
        filledQty: order.filledQty,
        closeClientOrderId: clientOrderId,
      },
      'ladder.post_error_fill: rung filled after error — placing protective close'
    )
    if (opts.beforeCreateOrder) {
      await opts
        .beforeCreateOrder({
          intentId: s.intent.id,
          clientOrderId,
          exchange: s.intent.exchange,
          symbol: s.intent.exchangeSymbol,
          side: closeSide,
          kind: 'close',
          orderType: 'market',
          qty: order.filledQty,
          reduceOnly: true,
        })
        .catch((err: unknown) => {
          logger.warn({ intentId: s.intent.id, err }, 'manager: durability write failed for post-error close')
        })
    }
    try {
      await rest.createOrder({
        intentId: s.intent.id,
        clientOrderId,
        exchange: s.intent.exchange,
        symbol: s.intent.exchangeSymbol,
        side: closeSide,
        type: 'market',
        qty: order.filledQty,
        reduceOnly: true,
      })
      logger.warn(
        { event: 'ladder.post_error_close_placed', intentId: s.intent.id, clientOrderId, filledQty: order.filledQty },
        'ladder.post_error_close_placed'
      )
    } catch (err) {
      logger.error(
        { event: 'ladder.post_error_close_failed', intentId: s.intent.id, err },
        'ladder.post_error_close_failed'
      )
    }
  }

  function handleEntryOrderEvent(
    s: IntentState,
    order: { clientOrderId: string; exchangeOrderId?: string; status: string; filledQty: number; avgFillPrice?: number }
  ): void {
    if (TERMINAL.has(s.status) || s.status === 'exiting') {
      // Ladder rung filled after the cancel-on-exit decision (cancel/fill race, §G-R) — the
      // ladder's unfilled rungs stay live until SL/TP/deadline fires, so this is reachable for
      // any terminal/exiting status, not just the ladder_no_fills error path.
      if (
        s.intent.entryPolicy?.kind === 'ladder_limit' &&
        (order.status === 'filled' || order.status === 'partially_filled') &&
        order.filledQty > 0
      ) {
        void placeLadderPostErrorProtectiveClose(s, order)
      }
      return
    }

    // Ladder intents (R11): the SL is engine-tracked from placement (spawnLadderTracker) and the
    // TP arms/re-places on each rung fill via ladderFillListeners; rungs stay live until SL/TP/
    // deadline fires (handleMonitorExit), never cancelled here.
    if (s.intent.entryPolicy?.kind === 'ladder_limit' && s.ladderRungs) {
      const canonId = canonicalize(s.intent.exchange, order.clientOrderId)
      const rung = s.ladderRungs.find(r => r.canonicalId === canonId)
      if (!rung || rung.filled) return

      if (order.status === 'filled' || order.status === 'partially_filled') {
        const wasUnfilled = s.filledQty <= 0
        if (order.status === 'filled') {
          rung.filled = true
          rung.filledQty = order.filledQty > 0 ? order.filledQty : rung.filledQty
          rung.avgFillPrice = order.avgFillPrice ?? rung.avgFillPrice
        } else {
          rung.filledQty = Math.max(rung.filledQty, order.filledQty)
          if (order.avgFillPrice !== undefined) rung.avgFillPrice = order.avgFillPrice
        }

        // Recompute aggregate fill state from all rungs.
        let totalQty = 0
        let totalQtyPrice = 0
        for (const r of s.ladderRungs) {
          if (r.filledQty > 0) {
            totalQty += r.filledQty
            totalQtyPrice += r.filledQty * r.avgFillPrice
          }
        }
        s.filledQty = totalQty
        if (totalQty > 0) s.avgEntryPrice = totalQtyPrice / totalQty

        // Status was already advanced to 'monitoring' at ladder placement (SL armed with the
        // ladder, R11) — don't regress it back to 'partially_filled'.
        if (s.status !== 'monitoring') transition(s, 'partially_filled')

        if (wasUnfilled && totalQty > 0) {
          const posOpened: PositionOpenedEvent = {
            intentId: s.intent.id,
            exchange: s.intent.exchange,
            symbol: s.intent.symbol,
            side: s.intent.side,
            filledQty: s.filledQty,
            ...(s.avgEntryPrice !== undefined ? { avgEntryPrice: s.avgEntryPrice } : {}),
          }
          bus.emit('position.opened', posOpened)
          logger.info({ event: 'position.opened', ...posOpened }, 'position.opened')
        }

        // Emit deviation metric if a rung fills before T_funding (scenario A invariant).
        if (order.status === 'filled' && clock.now() < s.intent.nextFundingTimestamp) {
          logger.warn(
            {
              event: 'ladder.pre_funding_fill',
              intentId: s.intent.id,
              clientOrderId: order.clientOrderId,
              fundingTs: s.intent.nextFundingTimestamp,
            },
            'ladder rung filled before T_funding — funding accrual deviation (keeping position)'
          )
          metrics.intentRejectedTotal.inc(1, {
            exchange: s.intent.exchange,
            strategy: s.intent.strategy,
            code: 'ladder_pre_funding_fill',
          })
        }

        // Arm/re-place the TP at the new P_avg (R11 step 3) — first fill places it, each
        // deeper fill cancels + re-places. The SL is unaffected (fixed at P_avg_full).
        ladderFillListeners.get(s.intent.id)?.()
      }
      return
    }

    if (s.intent.entryPolicy?.kind === 'pre_funding_then_main' && s.preFundingOrderId) {
      const canonId = order.clientOrderId ? canonicalize(s.intent.exchange, order.clientOrderId) : ''
      const preCanonId = canonicalize(s.intent.exchange, s.preFundingOrderId)
      const mainCanonId = s.entryOrderId ? canonicalize(s.intent.exchange, s.entryOrderId) : ''
      // Priority 1: clientOrderId matches MAIN order — block misroute regardless of exchangeOrderId collision.
      // Priority 2: clientOrderId matches pre-funding order.
      // Priority 3: fall back to exchangeOrderId only when clientOrderId absent; clamp by preFundingVolume.
      const isPreFunding =
        canonId !== '' && mainCanonId !== '' && canonId === mainCanonId
          ? false
          : canonId !== ''
            ? canonId === preCanonId
            : order.exchangeOrderId !== undefined &&
              order.exchangeOrderId === s.preFundingExchangeOrderId &&
              order.filledQty <= s.intent.entryPolicy.preFundingVolume * 1.5
      if (isPreFunding) {
        if (order.filledQty > (s.preFundingFilledQty ?? 0)) {
          s.preFundingFilledQty = order.filledQty
          if (order.avgFillPrice !== undefined) s.preFundingAvgFillPrice = order.avgFillPrice
        }
        if (order.status === 'filled') {
          if (!s.preFundingFilledEmitted) {
            s.preFundingFilledEmitted = true
            s.preFundingFilledAt = clock.now()
            const filled: OrderFilledEvent = {
              intentId: s.intent.id,
              exchange: s.intent.exchange,
              symbol: s.intent.symbol,
              clientOrderId: s.preFundingOrderId,
              filledQty: order.filledQty,
              ...(order.avgFillPrice !== undefined ? { avgFillPrice: order.avgFillPrice } : {}),
            }
            bus.emit('order.filled', filled)
            logger.info({ event: 'strategy6.pre_funding_filled', ...filled }, 'strategy6.pre_funding_filled')
            if (s.status === 'working' || s.status === 'acked') emitState(s)
          }
        } else if (order.status === 'partially_filled') {
          emitState(s)
        } else if (order.status === 'cancelled' || order.status === 'rejected') {
          setError(s, `pre_funding_${order.status}`, `pre-funding order ${order.status}`)
        }
        return
      }
    }

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
      // Fast-fill path: WS fill arrived before REST ACK updated the FSM. Synthesize acked→working
      // so the audit trail always shows submitted→acked→working→filled even on sub-millisecond fills.
      if (s.status === 'submitted') {
        logger.info(
          { event: 'order.fast_fill', intentId: s.intent.id, exchange: s.intent.exchange, symbol: s.intent.symbol },
          'order.fast_fill: WS fill raced REST ACK — synthesizing acked/working transitions'
        )
        transition(s, 'acked')
        transition(s, 'working')
      }
      const now = clock.now()
      metrics.intentEntryLatencyMs.observe(now - s.intent.decidedAt, {
        exchange: s.intent.exchange,
        strategy: s.intent.strategy,
      })
      entryFilledAt.set(s.intent.id, now)
      if (s.s6Timeline) {
        s.s6Timeline.mainFillAt = now
        logger.info(
          {
            event: 'strategy6.event_timeline',
            intentId: s.intent.id,
            exchange: s.intent.exchange,
            symbol: s.intent.symbol,
            tSettle: s.s6Timeline.tSettle,
            eventReceiveAt: s.s6Timeline.eventReceiveAt,
            eventLatencyMs: s.s6Timeline.eventReceiveAt - s.s6Timeline.tSettle,
            mainSendAt: s.s6Timeline.mainSendAt,
            mainFillAt: s.s6Timeline.mainFillAt,
            settledFundingRatePercent: s.settledFundingRatePercent,
          },
          'strategy6.event_timeline'
        )
      }
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

  const POLL_GET_ORDER_TIMEOUT_MS = 10_000

  function withGetOrderTimeout(promise: Promise<Order | undefined>): Promise<Order | undefined> {
    return Promise.race([
      promise,
      new Promise<undefined>(resolve =>
        setTimeout(() => {
          resolve(undefined)
        }, POLL_GET_ORDER_TIMEOUT_MS)
      ),
    ])
  }

  async function pollForEntryFill(
    s: IntentState,
    clientOrderId: string,
    exchangeOrderId: string,
    rest: ExchangeRestAdapter
  ): Promise<void> {
    const MAX_POLLS = 15
    let consecutiveErrors = 0
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise<void>(r => setTimeout(r, 1000))
      if (TERMINAL.has(s.status) || s.status !== 'working') return
      try {
        const ref = exchangeOrderId
          ? { symbol: s.intent.exchangeSymbol, clientOrderId, exchangeOrderId }
          : { symbol: s.intent.exchangeSymbol, clientOrderId }
        const order = await withGetOrderTimeout(rest.getOrder(ref))
        if (order) {
          handleEntryOrderEvent(s, order)
          if (order.status === 'filled' || order.status === 'partially_filled') {
            // Prefer the locally-tracked clientOrderId over order.clientOrderId from REST:
            // CCXT may prefix the clientOrderId (e.g. Binance adds 'x-r1wQQsTn') before
            // submission, so the exchange response returns the prefixed/truncated string
            // which wouldn't match what we stored in the DB.
            const effectiveCid = clientOrderId || order.clientOrderId
            const effectiveEoid = order.exchangeOrderId || exchangeOrderId
            const now = clock.now()
            // Re-check status: WS fast_fill may have advanced the intent while REST was in-flight.
            // Emitting synthetic ws.order/ws.fill after WS already processed the fill causes duplicates.

            if (TERMINAL.has(s.status) || (s.status as string) !== 'working') return
            bus.emit('ws.order', {
              exchange: s.intent.exchange,
              seq: 0,
              receivedAt: now,
              order: { ...order, clientOrderId: effectiveCid, exchangeOrderId: effectiveEoid },
            })
            if (order.status === 'filled' && order.filledQty > 0) {
              bus.emit('ws.fill', {
                exchange: s.intent.exchange,
                symbol: order.symbol,
                clientOrderId: effectiveCid,
                ...(effectiveEoid ? { exchangeOrderId: effectiveEoid } : {}),
                exchangeFillId: `poll:${effectiveEoid || effectiveCid}`,
                qty: order.filledQty,
                price: order.avgFillPrice ?? 0,
                feeAsset: 'USDT',
                feeAmount: 0,
                isMaker: false,
                ts: order.updatedAt,
                receivedAt: now,
              })
            }
          }
        }
        consecutiveErrors = 0
      } catch (err) {
        logger.warn({ intentId: s.intent.id, attempt: i + 1, err }, 'manager: entry poll failed')
        consecutiveErrors++
        if (consecutiveErrors >= 3) {
          logger.warn(
            { event: 'poll.entry.circuit_open', intentId: s.intent.id, consecutiveErrors },
            'poll.entry.circuit_open'
          )
          break
        }
      }
    }
    // ORDER_NOT_FOUND (e.g. Gate.io purges archived orders) causes getOrder to return undefined,
    // leaving the intent stuck in 'working'. Confirm via all positions (no symbol filter —
    // exchange-specific fetchPositions([sym]) can return empty even when position exists).
    if (TERMINAL.has(s.status) || s.status !== 'working') return
    logger.warn({ event: 'poll.entry.exhausted', intentId: s.intent.id, attempts: MAX_POLLS }, 'poll.entry.exhausted')
    try {
      const allPositions = await rest.getPositions()
      const pos = allPositions.find(
        p => p.symbol === s.intent.symbol || p.symbol === s.intent.exchangeSymbol || p.symbol.includes(s.intent.symbol)
      )
      if (!pos || pos.qty === 0) {
        logger.warn(
          { intentId: s.intent.id, exchange: s.intent.exchange, symbol: s.intent.symbol },
          'manager: entry poll exhausted with no fill; position flat — treating as cancelled entry'
        )
        setError(s, 'cancelled', 'entry order not found after poll exhausted (likely cancelled)')
      }
      // Position exists with qty > 0: the fill was real but getOrder failed (e.g. ORDER_NOT_FOUND
      // after rapid archival). Synthesise a filled order event so the intent can proceed.
      else {
        logger.warn(
          { intentId: s.intent.id, exchange: s.intent.exchange, symbol: s.intent.symbol, qty: pos.qty },
          'manager: entry poll exhausted but position open — synthesising fill'
        )
        handleEntryOrderEvent(s, {
          clientOrderId,
          ...(exchangeOrderId ? { exchangeOrderId } : {}),
          status: 'filled',
          filledQty: pos.qty,
          ...(pos.entryPrice !== undefined ? { avgFillPrice: pos.entryPrice } : {}),
        })
        const now = clock.now()
        bus.emit('ws.order', {
          exchange: s.intent.exchange,
          seq: 0,
          receivedAt: now,
          order: {
            exchange: s.intent.exchange,
            symbol: s.intent.exchangeSymbol,
            clientOrderId,
            exchangeOrderId,
            side: s.intent.side === 'long' ? 'buy' : 'sell',
            type: 'market',
            qty: pos.qty,
            filledQty: pos.qty,
            reduceOnly: false,
            status: 'filled',
            submittedAt: now,
            updatedAt: now,
            ...(pos.entryPrice !== undefined ? { avgFillPrice: pos.entryPrice } : {}),
          },
        })
        if (pos.qty > 0) {
          bus.emit('ws.fill', {
            exchange: s.intent.exchange,
            symbol: s.intent.exchangeSymbol,
            clientOrderId,
            ...(exchangeOrderId ? { exchangeOrderId } : {}),
            exchangeFillId: `poll:${exchangeOrderId || clientOrderId}`,
            qty: pos.qty,
            price: pos.entryPrice ?? 0,
            feeAsset: 'USDT',
            feeAmount: 0,
            isMaker: false,
            ts: now,
            receivedAt: now,
          })
        }
      }
    } catch (err) {
      logger.warn({ intentId: s.intent.id, err }, 'manager: entry poll exhausted — position check failed')
    }
  }

  async function pollForCloseFill(
    s: IntentState,
    closeId: string,
    closeExchangeOrderId: string | undefined,
    rest: ExchangeRestAdapter,
    onExhausted?: () => void
  ): Promise<void> {
    const MAX_POLLS = 20
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise<void>(r => setTimeout(r, 1000))
      if (TERMINAL.has(s.status) || s.status !== 'exiting') return
      try {
        const ref = closeExchangeOrderId
          ? { symbol: s.intent.exchangeSymbol, clientOrderId: closeId, exchangeOrderId: closeExchangeOrderId }
          : { symbol: s.intent.exchangeSymbol, clientOrderId: closeId }
        const order = await withGetOrderTimeout(rest.getOrder(ref))
        if (order?.status === 'filled') {
          if (order.avgFillPrice !== undefined) s.avgExitPrice = order.avgFillPrice
          recordExitMetrics(s, s.exitReason ?? 'error')
          emitIntentExited(s)
          transition(s, 'exited')
          const effectiveCid = closeId || order.clientOrderId
          const effectiveEoid = (order.exchangeOrderId || closeExchangeOrderId) ?? ''
          const now = clock.now()
          bus.emit('ws.order', {
            exchange: s.intent.exchange,
            seq: 0,
            receivedAt: now,
            order: { ...order, clientOrderId: effectiveCid, exchangeOrderId: effectiveEoid },
          })
          if (order.filledQty > 0) {
            bus.emit('ws.fill', {
              exchange: s.intent.exchange,
              symbol: order.symbol,
              clientOrderId: effectiveCid,
              ...(effectiveEoid ? { exchangeOrderId: effectiveEoid } : {}),
              exchangeFillId: `poll:${effectiveEoid || effectiveCid}`,
              qty: order.filledQty,
              price: order.avgFillPrice ?? 0,
              feeAsset: 'USDT',
              feeAmount: 0,
              isMaker: false,
              ts: order.updatedAt,
              receivedAt: now,
            })
          }
          logger.info(
            {
              event: 'intent.exited.complete',
              intentId: s.intent.id,
              exchange: s.intent.exchange,
              symbol: s.intent.symbol,
              exitReason: s.exitReason,
            },
            'intent.exited.complete'
          )
          void sweepReduceOnlyOrders(rest, s.intent.exchangeSymbol, s.intent.id)
          return
        }
        // 'cancelled' close order means position was already flat (e.g. SL triggered before
        // the deadline market close arrived). Treat same as position-size fallback below.
        const isCancelled = order?.status === 'cancelled'
        // Fallback: if order not found or cancelled (e.g. Bitget archives filled orders quickly,
        // Gate.io cancels reduce-only on empty position), confirm via position size.
        if (order === undefined || isCancelled) {
          const positions = await rest.getPositions(s.intent.exchangeSymbol)
          const pos = positions.find(p => p.symbol === s.intent.symbol || p.symbol.includes(s.intent.symbol))
          if (!pos || pos.qty === 0) {
            recordExitMetrics(s, s.exitReason ?? 'error')
            emitIntentExited(s)
            transition(s, 'exited')
            const effectiveCid = closeId || (order?.clientOrderId ?? '')
            const effectiveEoid = (order?.exchangeOrderId ?? '') || (closeExchangeOrderId ?? '')
            const now = clock.now()
            bus.emit('ws.order', {
              exchange: s.intent.exchange,
              seq: 0,
              receivedAt: now,
              order: {
                exchange: s.intent.exchange,
                symbol: s.intent.exchangeSymbol,
                clientOrderId: effectiveCid,
                exchangeOrderId: effectiveEoid,
                side: s.intent.side === 'long' ? 'sell' : 'buy',
                type: 'market',
                qty: 0,
                filledQty: 0,
                reduceOnly: true,
                status: 'filled',
                submittedAt: now,
                updatedAt: now,
              },
            })
            logger.info(
              {
                event: 'intent.exited.complete',
                intentId: s.intent.id,
                exchange: s.intent.exchange,
                symbol: s.intent.symbol,
                exitReason: s.exitReason,
              },
              'intent.exited.complete'
            )
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
    onExhausted?.()
  }

  async function pollForSlTpFill(s: IntentState): Promise<void> {
    const { intent } = s
    const rest = restAdapters.get(intent.exchange)
    if (!rest || !s.exitOrderRefs) return
    const { sl: slRef, tp: tpRef } = s.exitOrderRefs
    if (!slRef && !tpRef) return

    const POLL_INTERVAL_MS = 5_000
    const MAX_POLLS = 150 // 150 × 5s = ~12 min, well within any deadline

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
          if (slOrder?.status === 'filled') {
            if (slOrder.avgFillPrice !== undefined) s.avgExitPrice = slOrder.avgFillPrice
            monitor.disarm(intent.id)
            const triggerTs = slOrder.updatedAt
            bus.emit('exit.triggered', {
              intentId: intent.id,
              exchange: intent.exchange,
              symbol: intent.symbol,
              reason: 'sl_hit',
              triggerTs,
              source: 'rest_poll',
              exitOrderClientId: slRef.clientOrderId,
              ...(slOrder.avgFillPrice !== undefined ? { triggerPrice: slOrder.avgFillPrice } : {}),
              latencyMs: clock.now() - triggerTs,
            })
            await handleMonitorExit(s, 'sl_hit')
            return
          }
        }
        if (tpRef) {
          const tpOrder = await withGetOrderTimeout(
            rest.getOrder({
              symbol: intent.exchangeSymbol,
              clientOrderId: tpRef.clientOrderId,
              ...(tpRef.exchangeOrderId ? { exchangeOrderId: tpRef.exchangeOrderId } : {}),
            })
          )
          if (tpOrder?.status === 'filled') {
            if (tpOrder.avgFillPrice !== undefined) s.avgExitPrice = tpOrder.avgFillPrice
            monitor.disarm(intent.id)
            const triggerTs = tpOrder.updatedAt
            bus.emit('exit.triggered', {
              intentId: intent.id,
              exchange: intent.exchange,
              symbol: intent.symbol,
              reason: 'tp_hit',
              triggerTs,
              source: 'rest_poll',
              exitOrderClientId: tpRef.clientOrderId,
              ...(tpOrder.avgFillPrice !== undefined ? { triggerPrice: tpOrder.avgFillPrice } : {}),
              latencyMs: clock.now() - triggerTs,
            })
            await handleMonitorExit(s, 'tp_hit')
            return
          }
        }
      } catch (err) {
        logger.warn({ intentId: intent.id, attempt: i + 1, err }, 'manager: sl/tp poll failed')
      }
    }
    logger.warn(
      {
        event: 'poll.sl_tp.exhausted',
        intentId: intent.id,
        attempts: MAX_POLLS,
        slClientOrderId: slRef?.clientOrderId,
        tpClientOrderId: tpRef?.clientOrderId,
      },
      'poll.sl_tp.exhausted'
    )
  }

  async function sweepReduceOnlyOrders(
    rest: ExchangeRestAdapter,
    exchangeSymbol: string,
    intentId: string
  ): Promise<void> {
    logger.debug(
      { event: 'oco.sweep.start', intentId, exchange: rest.exchange, symbol: exchangeSymbol },
      'oco.sweep.start'
    )
    try {
      const open = await rest.getOpenOrders(exchangeSymbol)
      const reduceOnly = open.filter(o => o.reduceOnly)
      if (reduceOnly.length === 0) {
        logger.debug(
          {
            event: 'oco.sweep.complete',
            intentId,
            exchange: rest.exchange,
            symbol: exchangeSymbol,
            foundCount: 0,
            cancelledCount: 0,
          },
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
            .catch((err: unknown) => {
              logger.warn(
                { intentId, exchange: rest.exchange, orderId: o.clientOrderId, err },
                'manager: post-exit cancel failed'
              )
            })
        )
      )
      const cancelledCount = results.filter(r => r.status === 'fulfilled').length
      const failedCount = results.filter(r => r.status === 'rejected').length
      logger.info(
        {
          event: 'oco.sweep.complete',
          intentId,
          exchange: rest.exchange,
          symbol: exchangeSymbol,
          foundCount: reduceOnly.length,
          cancelledCount,
          failedCount,
          foundOrderIds: reduceOnly.map(o => o.clientOrderId),
        },
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

    // Codes that mean the order is already gone — treat as cancel-success.
    // INVALID_PARAM_VALUE is intentionally excluded: Gate.io returns it for cancel-by-text on
    // stop_market orders (text not associated with trigger orders), which is NOT "already gone".
    const CANCEL_GONE_CODES = new Set(['TEXT_DUPLICATED', 'ORDER_NOT_FOUND', 'ORDER_FINISHED'])

    // Strategy A: cancel by clientOrderId
    logger.info({ event: 'oco.cancel.attempt', strategy: 'A', ...ctx }, 'oco.cancel.attempt')
    try {
      await rest.cancelOrder({ symbol: exchangeSymbol, clientOrderId: ref.clientOrderId })
    } catch (err) {
      const code = (err as { code?: string }).code ?? String(err)
      const isGone = CANCEL_GONE_CODES.has(code)
      logger.info(
        { event: isGone ? 'oco.cancel.already_gone' : 'oco.cancel.error', strategy: 'A', ...ctx, code },
        isGone ? 'oco.cancel.already_gone' : 'oco.cancel.error'
      )
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
      } catch (err) {
        const code = (err as { code?: string }).code ?? String(err)
        const isGone = CANCEL_GONE_CODES.has(code)
        logger.info(
          { event: isGone ? 'oco.cancel.already_gone' : 'oco.cancel.error', strategy: 'B', ...ctx, code },
          isGone ? 'oco.cancel.already_gone' : 'oco.cancel.error'
        )
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

  async function handleMonitorExit(s: IntentState, reason: TerminalMarker): Promise<void> {
    if (TERMINAL.has(s.status) || s.status === 'exiting') return

    const exitStartedAt = clock.now()
    logger.info(
      {
        event: 'intent.exiting.start',
        intentId: s.intent.id,
        exchange: s.intent.exchange,
        symbol: s.intent.symbol,
        reason,
      },
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

    // R11 ladder lifecycle: unfilled rungs are cancelled ONLY here, when SL/TP/deadline fires —
    // never earlier. Best-effort; a fill racing this cancel is closed by the protective-close
    // path in handleEntryOrderEvent (status 'exiting' at that point).
    if (s.ladderRungs && s.ladderRungs.length > 0) {
      const rungsToCancel = s.ladderRungs.filter(r => !r.filled)
      await Promise.allSettled(
        rungsToCancel.map(r =>
          rest.cancelOrder({ symbol: intent.exchangeSymbol, clientOrderId: r.clientOrderId }).catch((err: unknown) => {
            logger.warn(
              { intentId: intent.id, clientOrderId: r.clientOrderId, err },
              'manager: ladder rung cancel failed (exit)'
            )
          })
        )
      )
    }

    // R11: zero rungs ever filled by the deadline — terminal ladder_no_fills, no position/exit.
    if (s.ladderRungs && s.ladderRungs.length > 0 && reason === 'deadline' && s.filledQty <= 0) {
      logger.warn({ event: 'ladder.no_fills', intentId: intent.id }, 'ladder.no_fills')
      setError(s, 'ladder_no_fills', 'no ladder rungs filled by deadline')
      return
    }

    // A resting exchange SL/TP order already filled (detected by monitor via WS) only when this
    // reason's ref was actually armed — the R11 ladder's SL is engine-tracked (no resting order),
    // so an 'sl_hit' with no exitOrderRefs.sl falls through to the active-close branch below.
    const restingExitOrderFired =
      (reason === 'sl_hit' && s.exitOrderRefs?.sl !== undefined) ||
      (reason === 'tp_hit' && s.exitOrderRefs?.tp !== undefined)

    if (restingExitOrderFired) {
      // One exit order already filled (detected by monitor). Cancel the residual.
      const residualRef = reason === 'sl_hit' ? s.exitOrderRefs?.tp : s.exitOrderRefs?.sl
      if (residualRef) {
        // Snapshot open orders before cancelling to detect the dual-fill race:
        // if the residual order disappears from open orders AND is filled, both exits fired.
        let residualWasOpen = false
        try {
          const openBefore = await rest.getOpenOrders(intent.exchangeSymbol)
          residualWasOpen = openBefore.some(
            o =>
              o.clientOrderId === residualRef.clientOrderId ||
              (residualRef.exchangeOrderId !== undefined && o.exchangeOrderId === residualRef.exchangeOrderId)
          )
        } catch {
          // ignore — proceed with cancel regardless
        }

        const cancelResult = await cancelSiblingExit(rest, intent, residualRef)
        if (cancelResult === 'cancelled') {
          // Emit synthetic order event so the persistence writer marks the residual row cancelled.
          const now = clock.now()
          bus.emit('ws.order', {
            exchange: intent.exchange,
            seq: 0,
            receivedAt: now,
            order: {
              exchange: intent.exchange,
              symbol: intent.exchangeSymbol,
              clientOrderId: residualRef.clientOrderId,
              exchangeOrderId: residualRef.exchangeOrderId ?? '',
              side: exitSide,
              type: 'stop_market',
              qty: 0,
              filledQty: 0,
              reduceOnly: true,
              status: 'cancelled',
              submittedAt: now,
              updatedAt: now,
            },
          })
        }

        // Check if the residual was actually filled (not just cancelled) — dual-fill race.
        if (residualWasOpen) {
          try {
            const residualOrder = await rest.getOrder({
              symbol: intent.exchangeSymbol,
              clientOrderId: residualRef.clientOrderId,
              ...(residualRef.exchangeOrderId ? { exchangeOrderId: residualRef.exchangeOrderId } : {}),
            })
            if (residualOrder?.status === 'filled' && residualOrder.filledQty > 0) {
              s.oco = { bothFilled: true }
              bus.emit('ops.event', {
                ts: clock.now(),
                level: 'warn',
                exchange: intent.exchange,
                eventType: 'oco.both_filled',
                payload: {
                  intentId: intent.id,
                  primaryReason: reason,
                  secondaryReason: reason === 'sl_hit' ? 'tp_hit' : 'sl_hit',
                },
              })
              logger.warn(
                {
                  event: 'oco.both_filled',
                  intentId: intent.id,
                  primaryReason: reason,
                  secondaryReason: reason === 'sl_hit' ? 'tp_hit' : 'sl_hit',
                },
                'oco.both_filled: both SL and TP filled'
              )
            }
          } catch {
            // ignore — dual-fill telemetry is best-effort
          }
        }
      }
      // Defense in depth: sweep any remaining reduce-only orders for this symbol.
      // cancelSiblingExit above can exhaust all strategies; a duplicate SL placement may also
      // have slipped through. The sweep ensures no orphaned reduce-only orders remain after exit.
      await sweepReduceOnlyOrders(rest, intent.exchangeSymbol, intent.id)
      recordExitMetrics(s, reason)
      emitIntentExited(s)
      transition(s, 'exited')
      logger.info(
        {
          event: 'intent.exited.complete',
          intentId: intent.id,
          exchange: intent.exchange,
          symbol: intent.symbol,
          exitReason: reason,
          durationMs: clock.now() - exitStartedAt,
        },
        'intent.exited.complete'
      )
    } else {
      // timed / deadline / kill_switch → place market close immediately, then cancel siblings in parallel.
      // Snapshot sibling refs BEFORE overwriting s.exitOrderRefs so the cancel loop retains them.
      const siblingRefs = s.exitOrderRefs
        ? [s.exitOrderRefs.sl, s.exitOrderRefs.tp].filter((r): r is ExitOrderRef => r !== undefined)
        : []

      const closeKind = reason === 'timed' ? 'timed' : 'close'
      const closeId = ids.forExit(intent.id, closeKind)
      const canonCloseId = canonicalize(intent.exchange, closeId)
      const closeQty = await confirmedCloseQty(s, rest)
      s.closeAttemptCount = (s.closeAttemptCount ?? 0) + 1
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
            qty: closeQty,
            reduceOnly: true,
          })
        } catch (err) {
          logger.warn({ intentId: intent.id, err }, 'manager: durability write failed for close order')
          bus.emit('ops.event', {
            ts: clock.now(),
            level: 'fatal',
            exchange: intent.exchange,
            eventType: 'durability_write_failed',
            payload: { intentId: intent.id, kind: closeKind, err: String(err) },
          })
        }
      }
      // Emit order.placed before the REST call so close order.placed always precedes order.filled
      // even when WS fill races back before the REST ACK (GateIO market closes).
      const closePlacedAt = clock.now()
      const closePlacedPre: OrderPlacedEvent = {
        intentId: intent.id,
        exchange: intent.exchange,
        symbol: intent.symbol,
        clientOrderId: closeId,
        kind: closeKind,
        side: exitSide,
        orderType: 'market',
        qty: closeQty,
        reduceOnly: true,
        ackPending: true,
      }
      bus.emit('order.placed', closePlacedPre)
      logger.info({ event: 'order.placed', ...closePlacedPre }, 'order.placed')

      try {
        const closeAck = await createOrderWithOkxWsFallback(intent.strategy, {
          intentId: intent.id,
          clientOrderId: closeId,
          exchange: intent.exchange,
          symbol: intent.exchangeSymbol,
          side: exitSide,
          type: 'market',
          qty: closeQty,
          reduceOnly: true,
        })
        if (closeAck.status === 'rejected') {
          byCloseOrderId.delete(canonCloseId)
          delete s.exitOrderRefs
          logger.error({ intentId: intent.id, rejectReason: closeAck.rejectReason }, 'manager: market close rejected')
          setError(s, 'close_rejected', closeAck.rejectReason ?? 'market close rejected')
          return
        }
        if (closeAck.exchangeOrderId) {
          byCloseExchangeOrderId.set(closeAck.exchangeOrderId, intent.id)
          s.exitOrderRefs = { close: { clientOrderId: closeId, exchangeOrderId: closeAck.exchangeOrderId } }
          // Post-ACK emit to persist exchange_order_id in DB (pre-ACK emit had ackPending=true, no exchangeOrderId).
          bus.emit('order.placed', { ...closePlacedPre, exchangeOrderId: closeAck.exchangeOrderId, ackPending: false })
        }
        logger.info(
          {
            event: 'order.acked',
            intentId: intent.id,
            exchange: intent.exchange,
            symbol: intent.symbol,
            clientOrderId: closeId,
            kind: closeKind,
            ...(closeAck.exchangeOrderId ? { exchangeOrderId: closeAck.exchangeOrderId } : {}),
            ack_latency_ms: clock.now() - closePlacedAt,
          },
          'order.acked'
        )
        if (reason === 'deadline' && 'deadlineAt' in intent.exitPolicy) {
          logger.info(
            {
              event: 'manager.close.placed_after_deadline',
              intentId: intent.id,
              exchange: intent.exchange,
              latencyMs: clock.now() - intent.exitPolicy.deadlineAt,
            },
            'manager.close.placed_after_deadline'
          )
        }
        // Cancel residual SL/TP orders in parallel — reduce-only close guarantees no oversell.
        if (siblingRefs.length > 0) {
          void Promise.all(siblingRefs.map(ref => cancelSiblingExit(rest, intent, ref))).catch(() => {
            /* noop */
          })
        }
        // REST polling fallback for close fill (mirrors entry poll for WS-unreliable exchanges)
        const onCloseExhausted =
          reason === 'funding_fee_event'
            ? () => {
                void sweepReduceOnlyOrders(rest, intent.exchangeSymbol, intent.id)
                void opts.state.reconcile(intent.exchange)
              }
            : undefined
        void pollForCloseFill(s, closeId, closeAck.exchangeOrderId, rest, onCloseExhausted)
      } catch (err) {
        byCloseOrderId.delete(canonCloseId)
        delete s.exitOrderRefs
        logger.error({ intentId: intent.id, err }, 'manager: market close placement failed')
        setError(s, 'close_failed', String(err))
      }
    }
  }

  function recordExitMetrics(s: IntentState, reason: TerminalMarker): void {
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
          .catch((err: unknown) => {
            logger.warn({ intentId: s.intent.id, err }, 'preempt: cancel entry failed')
          })
      }
      void handleMonitorExit(s, 'kill_switch_flatten')
      return
    }

    // Clean up lookup maps before going terminal
    if (s.entryOrderId) byEntryOrderId.delete(canonicalize(s.intent.exchange, s.entryOrderId))
    if (s.entryExchangeOrderId) byEntryExchangeOrderId.delete(s.entryExchangeOrderId)
    transition(s, 'cancelled')
    if (rest && s.entryOrderId) {
      void rest
        .cancelOrder({ symbol: s.intent.exchangeSymbol, clientOrderId: s.entryOrderId })
        .catch((err: unknown) => {
          logger.warn({ intentId: s.intent.id, err }, 'preempt: cancel order failed (best effort)')
        })
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

  async function cancelStaleReduceOnlyOrders(
    rest: ExchangeRestAdapter,
    exchange: Exchange,
    exchangeSymbol: string,
    intentId: string
  ): Promise<void> {
    let openOrders: Awaited<ReturnType<typeof rest.getOpenOrders>>
    try {
      openOrders = await rest.getOpenOrders(exchangeSymbol)
    } catch {
      return
    }
    const canonicalize = (id: string): string => rest.canonicalizeClientOrderId?.(id) ?? id
    const stale = openOrders.filter(o => {
      if (!o.reduceOnly) return false
      const canonical = canonicalize(o.clientOrderId)
      return !byCloseOrderId.has(canonical) && !(o.exchangeOrderId && byCloseExchangeOrderId.has(o.exchangeOrderId))
    })
    if (stale.length === 0) return
    logger.warn(
      {
        event: 'pre_entry.stale_reduce_only_sweep',
        intentId,
        exchange,
        symbol: exchangeSymbol,
        count: stale.length,
        orderIds: stale.map(o => o.clientOrderId),
      },
      'pre_entry.stale_reduce_only_sweep: cancelling stale reduce-only orders before new entry'
    )
    await Promise.allSettled(
      stale.map(o =>
        rest
          .cancelOrder({
            symbol: exchangeSymbol,
            ...(o.clientOrderId ? { clientOrderId: o.clientOrderId } : {}),
            ...(o.exchangeOrderId ? { exchangeOrderId: o.exchangeOrderId } : {}),
          })
          .catch((err: unknown) => {
            logger.warn(
              { intentId, exchange, clientOrderId: o.clientOrderId, err },
              'pre_entry.stale_reduce_only_sweep: cancel failed'
            )
          })
      )
    )
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
        if (
          s.status === 'monitoring' &&
          (s.intent.exitPolicy.kind === 'sl_tp_deadline_retracement' ||
            s.intent.exitPolicy.kind === 'sl_tp_deadline_retracement_funding_event')
        ) {
          spawnRetracementTracker(s)
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
            if (s && (event.order.status === 'filled' || event.order.status === 'partially_filled')) {
              if (TERMINAL.has(s.status)) return
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
              if (event.order.status === 'filled') {
                recordExitMetrics(s, s.exitReason ?? 'error')
                emitIntentExited(s)
                transition(s, 'exited')
                logger.info(
                  {
                    event: 'intent.exited.complete',
                    intentId: closeIntentId,
                    exchange: s.intent.exchange,
                    symbol: s.intent.symbol,
                    exitReason: s.exitReason,
                  },
                  'intent.exited.complete'
                )
                const wsRest = restAdapters.get(s.intent.exchange)
                if (wsRest) void sweepReduceOnlyOrders(wsRest, s.intent.exchangeSymbol, s.intent.id)
              }
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
            if (typeof details.symbol !== 'string') return
            void flattenOrphanPosition(event.exchange, details)
            return
          }
          if (event.kind === 'orphan_reduce_only_order') {
            const details = event.details as {
              symbol: string
              clientOrderId: string
              exchangeOrderId?: string
            }
            if (typeof details.symbol !== 'string' || typeof details.clientOrderId !== 'string') return
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
        logger.warn(
          {
            event: 'preflight.rejected',
            exchange: intent.exchange,
            strategy: intent.strategy,
            symbol: intent.symbol,
            rejectionCode: check.code,
            rejectionText: check.message,
          },
          'preflight.rejected'
        )
        setError(s, check.code, check.message)
        metrics.intentRejectedTotal.inc(1, {
          exchange: intent.exchange,
          strategy: intent.strategy,
          code: check.code,
        })
        return s
      }

      // Market is guaranteed present — preflight already verified it.
      const market = opts.markets.get(intent.exchange, intent.symbol)
      if (!market) {
        setError(s, 'no_market', `no market for ${intent.exchange}:${intent.symbol}`)
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
        logger.warn(
          {
            event: 'preflight.rejected',
            exchange: intent.exchange,
            strategy: intent.strategy,
            symbol: intent.symbol,
            rejectionCode: 'set_leverage_failed',
            rejectionText: String(err),
          },
          'preflight.rejected'
        )
        setError(s, 'set_leverage_failed', `setLeverage failed: ${String(err)}`)
        metrics.intentRejectedTotal.inc(1, {
          exchange: intent.exchange,
          strategy: intent.strategy,
          code: 'set_leverage_failed',
        })
        return s
      }

      const entryPolicy = intent.entryPolicy ?? { kind: 'market' }
      const entrySide: 'buy' | 'sell' = intent.side === 'long' ? 'buy' : 'sell'

      // Sweep stale reduce-only orders from prior cycles before placing entry.
      // Prevents cross-cycle fills where an unconfirmed-cancelled SL/TP fills against the new position.
      await cancelStaleReduceOnlyOrders(rest, intent.exchange, intent.exchangeSymbol, intent.id)

      transition(s, 'submitted')
      // If the intent was preempted while ensureLeverage was in-flight, transition()
      // was a no-op (TERMINAL guard) and s.status is still 'cancelled' — bail early.
      if (TERMINAL.has(s.status)) return s
      bus.emit('intent.submitted', s)
      logger.info(
        {
          event: 'intent.submitted',
          intentId: intent.id,
          exchange: intent.exchange,
          symbol: intent.symbol,
          strategy: intent.strategy,
          entryKind: entryPolicy.kind,
        },
        'intent.submitted'
      )

      // ── Pre-funding then main entry (strategy_6) ────────────────────────────────
      if (entryPolicy.kind === 'pre_funding_then_main') {
        const { exitPolicy } = intent
        if (exitPolicy.kind !== 'sl_tp_deadline_post_funding_event') {
          setError(s, 'invalid_config', 'pre_funding_then_main requires sl_tp_deadline_post_funding_event exit policy')
          return s
        }

        const { fundingTs, timeoutAt } = exitPolicy
        const preFundingSide: OrderSide = entryPolicy.preFundingSide === 'long' ? 'buy' : 'sell'
        const mainSide: OrderSide = entryPolicy.mainSide === 'long' ? 'buy' : 'sell'
        const toleranceMs = 5_000

        // Guard: pre-funding qty computed at evaluation time using a stale price may violate
        // minNotional by submission time. Abort early before any side-effects are set up.
        if (!meetsMinNotional(entryPolicy.preFundingVolume, price, market)) {
          setError(
            s,
            'min_notional',
            `pre-funding notional ${String(entryPolicy.preFundingVolume * price)} below minCost ${String(market.minCost)}`
          )
          return s
        }

        const preFundingId = ids.forIntent(intent.id, 90)
        const canonPreFundingId = canonicalize(intent.exchange, preFundingId)
        s.preFundingOrderId = preFundingId
        byEntryOrderId.set(canonPreFundingId, intent.id)

        let mainEventLock: Promise<void> | null = null
        let fundingFeeUnsub: Unsubscribe | null = null
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null

        // Consolidated calibration log (§6.2.3) for the partial-fill/abort paths — the MAIN-fill
        // path emits its own copy (with mainFillAt) from handleEntryOrderEvent.
        const emitS6PartialTimeline = (): void => {
          if (!s.s6Timeline) return
          logger.info(
            {
              event: 'strategy6.event_timeline',
              intentId: intent.id,
              exchange: intent.exchange,
              symbol: intent.symbol,
              tSettle: s.s6Timeline.tSettle,
              eventReceiveAt: s.s6Timeline.eventReceiveAt,
              eventLatencyMs: s.s6Timeline.eventReceiveAt - s.s6Timeline.tSettle,
              mainSendAt: s.s6Timeline.mainSendAt,
              mainFillAt: s.s6Timeline.mainFillAt,
              settledFundingRatePercent: s.settledFundingRatePercent,
            },
            'strategy6.event_timeline'
          )
        }

        const closePreFunding = async () => {
          // Cancel the pre-funding order before closing to stop further fills.
          if (s.preFundingOrderId && !TERMINAL.has(s.status)) {
            try {
              await rest.cancelOrder({
                symbol: intent.exchangeSymbol,
                clientOrderId: s.preFundingOrderId,
                ...(s.preFundingExchangeOrderId ? { exchangeOrderId: s.preFundingExchangeOrderId } : {}),
              })
            } catch {
              // ignore — position fetch is ground truth
            }
          }

          const retryDelaysMs = [250, 1000, 3000]
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) {
              await new Promise<void>(resolve => setTimeout(resolve, retryDelaysMs[attempt - 1] ?? 250))
            }
            try {
              let actualFilled = 0
              let positionSnapshot: unknown[] = []
              try {
                const positions = await rest.getPositions(intent.exchangeSymbol)
                positionSnapshot = positions
                const pos = positions.find(
                  p =>
                    p.symbol === intent.symbol ||
                    p.symbol === intent.exchangeSymbol ||
                    normalizeSymbol(p.symbol) === intent.symbol
                )
                actualFilled = pos?.qty ?? 0
              } catch {
                actualFilled = s.preFundingFilledQty ?? 0
              }

              if (actualFilled <= 0) {
                logger.info(
                  {
                    intentId: intent.id,
                    preFundingFilledQty: s.preFundingFilledQty,
                    positionSnapshot,
                  },
                  'strategy6.closePreFunding: no position to close'
                )
                return
              }

              const closeId = ids.forIntent(intent.id, 91 + attempt)
              await rest.createOrder({
                intentId: intent.id,
                clientOrderId: closeId,
                exchange: intent.exchange,
                symbol: intent.exchangeSymbol,
                // entrySide = mainSide = opposite of preFundingSide = closing direction for PRE_FUNDING
                side: entrySide,
                type: 'market',
                qty: actualFilled,
                reduceOnly: true,
              })
              return
            } catch (err) {
              logger.warn({ intentId: intent.id, attempt, err }, 'strategy6.closePreFunding: attempt failed')
            }
          }

          logger.error({ intentId: intent.id }, 'strategy6.closePreFunding: all retries exhausted')
          bus.emit('ops.event', {
            ts: clock.now(),
            level: 'error',
            exchange: intent.exchange,
            eventType: 'close_pre_funding_failed',
            payload: { intentId: intent.id },
          })
          bus.emit('ops.event', {
            ts: clock.now(),
            level: 'fatal',
            exchange: intent.exchange,
            eventType: 'strategy6.canary_halt',
            payload: { intentId: intent.id, reason: 'close_pre_funding_failed' },
          })
          setError(s, 'close_pre_funding_failed', 'pre-funding close failed after 3 attempts')
          emitS6PartialTimeline()
        }

        const confirmPreFundingFilled = async (): Promise<boolean> => {
          if ((s.preFundingFilledQty ?? 0) > 0) return true
          try {
            const order = await withGetOrderTimeout(
              rest.getOrder({
                symbol: intent.exchangeSymbol,
                clientOrderId: preFundingId,
                ...(s.preFundingExchangeOrderId ? { exchangeOrderId: s.preFundingExchangeOrderId } : {}),
              })
            )
            if (order) handleEntryOrderEvent(s, order)
          } catch (err) {
            logger.warn({ intentId: intent.id, err }, 'strategy6: pre-funding fill confirmation failed')
          }
          return (s.preFundingFilledQty ?? 0) > 0
        }

        const placeMain = async () => {
          if (mainEventLock !== null || TERMINAL.has(s.status)) return
          let _resolve!: () => void
          mainEventLock = new Promise<void>(r => {
            _resolve = r
          })
          fundingFeeUnsub?.()
          if (timeoutHandle !== null) clearTimeout(timeoutHandle)
          try {
            const preFundingFilled = await confirmPreFundingFilled()
            if (!preFundingFilled) {
              setError(s, 'pre_funding_not_filled', 'pre-funding order was not confirmed filled before MAIN')
              void closePreFunding()
              return
            }

            const mainOrderId = ids.forIntent(intent.id, 0)
            const canonMainId = canonicalize(intent.exchange, mainOrderId)
            byEntryOrderId.set(canonMainId, intent.id)
            s.entryOrderId = mainOrderId

            if (opts.beforeCreateOrder) {
              await opts
                .beforeCreateOrder({
                  intentId: intent.id,
                  clientOrderId: mainOrderId,
                  exchange: intent.exchange,
                  symbol: intent.exchangeSymbol,
                  side: mainSide,
                  kind: 'entry',
                  orderType: 'market',
                  qty: entryPolicy.mainVolume,
                  reduceOnly: false,
                })
                .catch((err: unknown) => {
                  logger.warn({ intentId: intent.id, err }, 'manager: durability write failed for strategy6 main')
                  bus.emit('ops.event', {
                    ts: clock.now(),
                    level: 'fatal',
                    exchange: intent.exchange,
                    eventType: 'durability_write_failed',
                    payload: { intentId: intent.id, kind: 'entry', err: String(err) },
                  })
                })
            }

            s.s6Timeline = {
              tSettle: fundingTs,
              eventReceiveAt: clock.now(),
              ...s.s6Timeline,
              mainSendAt: clock.now(),
            }

            let ack
            try {
              ack = await createOrderWithOkxWsFallback(intent.strategy, {
                intentId: intent.id,
                clientOrderId: mainOrderId,
                exchange: intent.exchange,
                symbol: intent.exchangeSymbol,
                side: mainSide,
                type: 'market',
                qty: entryPolicy.mainVolume,
                leverage: intent.leverage,
              })
            } catch (err) {
              byEntryOrderId.delete(canonMainId)
              setError(s, 'main_order_failed', String(err))
              void closePreFunding()
              return
            }

            if (ack.status === 'rejected') {
              byEntryOrderId.delete(canonMainId)
              setError(s, 'main_order_rejected', ack.rejectReason ?? 'main order rejected')
              const rejectNow = clock.now()
              bus.emit('ws.order', {
                exchange: intent.exchange,
                seq: 0,
                receivedAt: rejectNow,
                order: {
                  exchange: intent.exchange,
                  symbol: intent.exchangeSymbol,
                  clientOrderId: mainOrderId,
                  exchangeOrderId: ack.exchangeOrderId,
                  side: mainSide,
                  type: 'market',
                  qty: entryPolicy.mainVolume,
                  filledQty: 0,
                  reduceOnly: false,
                  status: 'rejected',
                  ...(ack.rejectReason !== undefined ? { rejectReason: ack.rejectReason } : {}),
                  submittedAt: rejectNow,
                  updatedAt: rejectNow,
                },
              })
              void closePreFunding()
              return
            }

            if (ack.exchangeOrderId) {
              s.entryExchangeOrderId = ack.exchangeOrderId
              byEntryExchangeOrderId.set(ack.exchangeOrderId, intent.id)
            }

            bus.emit('order.placed', {
              intentId: intent.id,
              exchange: intent.exchange,
              symbol: intent.symbol,
              clientOrderId: mainOrderId,
              kind: 'entry',
              side: mainSide,
              orderType: 'market',
              qty: entryPolicy.mainVolume,
              reduceOnly: false,
              ...(ack.exchangeOrderId ? { exchangeOrderId: ack.exchangeOrderId } : {}),
            })
            logger.info(
              { event: 'strategy6.main_placed', intentId: intent.id, qty: entryPolicy.mainVolume },
              'strategy6.main_placed'
            )

            if (!TERMINAL.has(s.status) && s.status === 'working') {
              void pollForEntryFill(s, mainOrderId, ack.exchangeOrderId, rest)
            }
          } finally {
            _resolve()
          }
        }

        // Subscribe to ws.funding_fee for this (exchange, symbol)
        fundingFeeUnsub = bus.on('ws.funding_fee', event => {
          if (event.exchange !== intent.exchange) return
          if (event.symbol !== intent.symbol) return
          if (event.fundingTime < fundingTs - toleranceMs || event.fundingTime > fundingTs + toleranceMs) return
          if (Number.isFinite(event.fundingRate) && event.fundingRate !== 0) {
            s.settledFundingRatePercent = Math.abs(event.fundingRate) * 100
          }
          s.s6Timeline = { tSettle: fundingTs, eventReceiveAt: event.receivedAt, ...s.s6Timeline }
          void placeMain()
        })

        // Hard timeout: close PRE_FUNDING and abort if no event arrives
        const timeoutDelay = Math.max(0, timeoutAt - clock.now())
        timeoutHandle = setTimeout(() => {
          if (mainEventLock !== null || TERMINAL.has(s.status)) return
          mainEventLock = Promise.resolve()
          fundingFeeUnsub()
          logger.warn({ intentId: intent.id }, 'strategy6: funding fee timeout — closing pre-funding')
          void closePreFunding().then(() => {
            setError(s, 'funding_event_timeout', 'no ws.funding_fee event received within timeout')
            emitS6PartialTimeline()
          })
        }, timeoutDelay)

        // Place PRE_FUNDING order now
        if (opts.beforeCreateOrder) {
          await opts
            .beforeCreateOrder({
              intentId: intent.id,
              clientOrderId: preFundingId,
              exchange: intent.exchange,
              symbol: intent.exchangeSymbol,
              side: preFundingSide,
              kind: 'pre_funding',
              orderType: 'market',
              qty: entryPolicy.preFundingVolume,
              reduceOnly: false,
            })
            .catch((err: unknown) => {
              logger.warn({ intentId: intent.id, err }, 'manager: durability write failed for strategy6 pre-funding')
              bus.emit('ops.event', {
                ts: clock.now(),
                level: 'fatal',
                exchange: intent.exchange,
                eventType: 'durability_write_failed',
                payload: { intentId: intent.id, kind: 'pre_funding', err: String(err) },
              })
            })
        }

        let preFundingAck
        try {
          preFundingAck = await withSubmissionGate(intent.exchange, () =>
            createOrderWithOkxWsFallback(intent.strategy, {
              intentId: intent.id,
              clientOrderId: preFundingId,
              exchange: intent.exchange,
              symbol: intent.exchangeSymbol,
              side: preFundingSide,
              type: 'market',
              qty: entryPolicy.preFundingVolume,
              leverage: intent.leverage,
            })
          )
        } catch (err) {
          fundingFeeUnsub()
          clearTimeout(timeoutHandle)
          byEntryOrderId.delete(canonPreFundingId)
          setError(s, 'pre_funding_order_failed', String(err))
          return s
        }

        if (preFundingAck.status === 'rejected') {
          fundingFeeUnsub()
          clearTimeout(timeoutHandle)
          byEntryOrderId.delete(canonPreFundingId)
          setError(s, 'pre_funding_order_rejected', preFundingAck.rejectReason ?? 'pre-funding order rejected')
          return s
        }

        if (preFundingAck.exchangeOrderId) {
          s.preFundingExchangeOrderId = preFundingAck.exchangeOrderId
          byEntryExchangeOrderId.set(preFundingAck.exchangeOrderId, intent.id)
        }

        bus.emit('order.placed', {
          intentId: intent.id,
          exchange: intent.exchange,
          symbol: intent.symbol,
          clientOrderId: preFundingId,
          kind: 'pre_funding',
          side: preFundingSide,
          orderType: 'market',
          qty: entryPolicy.preFundingVolume,
          reduceOnly: false,
          ...(preFundingAck.exchangeOrderId ? { exchangeOrderId: preFundingAck.exchangeOrderId } : {}),
        })
        logger.info(
          { event: 'strategy6.pre_funding_placed', intentId: intent.id, qty: entryPolicy.preFundingVolume },
          'strategy6.pre_funding_placed'
        )

        if (s.status === 'submitted') transition(s, 'acked')
        if (s.status === 'acked') transition(s, 'working')

        if (!TERMINAL.has(s.status) && s.status === 'working') {
          void pollForEntryFill(s, preFundingId, preFundingAck.exchangeOrderId, rest)
        }

        return s
      }

      // ── Ladder limit entry ──────────────────────────────────────────────────────
      if (entryPolicy.kind === 'ladder_limit') {
        const rungs = entryPolicy.rungs
        const ladderRungState: LadderRung[] = rungs.map((rung, i) => {
          const clientOrderId = ids.forIntent(intent.id, i)
          const canonicalId = canonicalize(intent.exchange, clientOrderId)
          byEntryOrderId.set(canonicalId, intent.id)
          return {
            clientOrderId,
            canonicalId,
            qtyFraction: rung.qtyFraction,
            filled: false,
            filledQty: 0,
            avgFillPrice: 0,
          }
        })
        s.ladderRungs = ladderRungState
        if (ladderRungState[0]) s.entryOrderId = ladderRungState[0].clientOrderId

        // P_avg_full (R11): precomputed from the rungs actually feasible to place — known in
        // advance from their prices/quantities, independent of which ones eventually fill. The
        // SL is anchored to this fixed value with the ladder, not to the realized fill average.
        let pAvgFullNotional = 0
        let pAvgFullQty = 0
        for (const rung of rungs) {
          const rungQty = alignToLotStep(check.qty * rung.qtyFraction, market)
          const limitPrice =
            intent.side === 'long'
              ? price * (1 - rung.priceOffsetPct / 100)
              : price * (1 + rung.priceOffsetPct / 100)
          if (rungQty <= 0 || !meetsMinNotional(rungQty, limitPrice, market)) continue
          pAvgFullNotional += limitPrice * rungQty
          pAvgFullQty += rungQty
        }
        const pAvgFull = pAvgFullQty > 0 ? pAvgFullNotional / pAvgFullQty : undefined

        // Place all rungs in parallel; record each via durability hook first.
        if (opts.beforeCreateOrder) {
          const beforeCreate = opts.beforeCreateOrder
          await Promise.allSettled(
            rungs.map((rung, i) => {
              const rungState = ladderRungState[i]
              if (!rungState) return Promise.resolve()
              const rungQty = alignToLotStep(check.qty * rung.qtyFraction, market)
              const limitPrice =
                intent.side === 'long'
                  ? price * (1 - rung.priceOffsetPct / 100)
                  : price * (1 + rung.priceOffsetPct / 100)
              if (rungQty <= 0 || !meetsMinNotional(rungQty, limitPrice, market)) {
                logger.warn(
                  { intentId: intent.id, rungIdx: i, rungQty, limitPrice, minCost: market.minCost },
                  'ladder.rung_below_min_notional'
                )
                return Promise.resolve()
              }
              return beforeCreate({
                intentId: intent.id,
                clientOrderId: rungState.clientOrderId,
                exchange: intent.exchange,
                symbol: intent.exchangeSymbol,
                side: entrySide,
                kind: 'entry',
                orderType: 'limit',
                qty: rungQty,
                price: limitPrice,
                reduceOnly: false,
              }).catch((err: unknown) => {
                logger.warn(
                  { intentId: intent.id, rungIdx: i, err },
                  'manager: durability write failed for ladder rung'
                )
                bus.emit('ops.event', {
                  ts: clock.now(),
                  level: 'fatal',
                  exchange: intent.exchange,
                  eventType: 'durability_write_failed',
                  payload: { intentId: intent.id, kind: 'entry', err: String(err) },
                })
              })
            })
          )
        }

        if (s.status === 'submitted') transition(s, 'acked')
        if (s.status === 'acked') transition(s, 'working')

        // Place all limit orders in parallel, gated so concurrent intents don't burst.
        await withSubmissionGate(intent.exchange, () =>
          Promise.allSettled(
            rungs.map(async (rung, i) => {
              const rungState = ladderRungState[i]
              if (!rungState) return
              const rungQty = alignToLotStep(check.qty * rung.qtyFraction, market)
              const limitPrice =
                intent.side === 'long'
                  ? price * (1 - rung.priceOffsetPct / 100)
                  : price * (1 + rung.priceOffsetPct / 100)
              if (rungQty <= 0 || !meetsMinNotional(rungQty, limitPrice, market)) {
                byEntryOrderId.delete(rungState.canonicalId)
                logger.warn(
                  { intentId: intent.id, rungIdx: i, rungQty, limitPrice, minCost: market.minCost },
                  'ladder.rung_below_min_notional'
                )
                return
              }
              try {
                const ack = await rest.createOrder({
                  intentId: intent.id,
                  clientOrderId: rungState.clientOrderId,
                  exchange: intent.exchange,
                  symbol: intent.exchangeSymbol,
                  side: entrySide,
                  type: 'limit',
                  qty: rungQty,
                  price: limitPrice,
                  leverage: intent.leverage,
                })
                if (ack.exchangeOrderId) {
                  byEntryExchangeOrderId.set(ack.exchangeOrderId, intent.id)
                }
                if (ack.status === 'rejected') {
                  logger.warn({ intentId: intent.id, rungIdx: i, reason: ack.rejectReason }, 'ladder rung rejected')
                  byEntryOrderId.delete(rungState.canonicalId)
                  const rejectNow = clock.now()
                  bus.emit('ws.order', {
                    exchange: intent.exchange,
                    seq: 0,
                    receivedAt: rejectNow,
                    order: {
                      exchange: intent.exchange,
                      symbol: intent.exchangeSymbol,
                      clientOrderId: rungState.clientOrderId,
                      exchangeOrderId: ack.exchangeOrderId,
                      side: entrySide,
                      type: 'limit',
                      qty: rungQty,
                      filledQty: 0,
                      reduceOnly: false,
                      status: 'rejected',
                      ...(ack.rejectReason !== undefined ? { rejectReason: ack.rejectReason } : {}),
                      submittedAt: rejectNow,
                      updatedAt: rejectNow,
                    },
                  })
                  return
                }
                bus.emit('order.placed', {
                  intentId: intent.id,
                  exchange: intent.exchange,
                  symbol: intent.symbol,
                  clientOrderId: rungState.clientOrderId,
                  kind: 'entry',
                  side: entrySide,
                  orderType: 'limit',
                  qty: rungQty,
                  price: limitPrice,
                  reduceOnly: false,
                  ...(ack.exchangeOrderId ? { exchangeOrderId: ack.exchangeOrderId } : {}),
                })
                logger.info(
                  { event: 'ladder.rung_placed', intentId: intent.id, rungIdx: i, limitPrice, rungQty },
                  'ladder.rung_placed'
                )
              } catch (err) {
                byEntryOrderId.delete(rungState.canonicalId)
                logger.warn({ intentId: intent.id, rungIdx: i, err }, 'ladder rung placement failed')
                const failNow = clock.now()
                bus.emit('ws.order', {
                  exchange: intent.exchange,
                  seq: 0,
                  receivedAt: failNow,
                  order: {
                    exchange: intent.exchange,
                    symbol: intent.exchangeSymbol,
                    clientOrderId: rungState.clientOrderId,
                    exchangeOrderId: '',
                    side: entrySide,
                    type: 'limit',
                    qty: rungQty,
                    filledQty: 0,
                    reduceOnly: false,
                    status: 'cancelled',
                    submittedAt: failNow,
                    updatedAt: failNow,
                  },
                })
              }
            })
          )
        )

        // R11: the SL is placed WITH the ladder (fixed at P_avg_full, computed above from the
        // rungs actually feasible to place) — not after a T_funding cancel-then-arm. Unfilled
        // rungs stay live until SL/TP/deadline fires (handleMonitorExit cancels them there).
        if (pAvgFull === undefined) {
          // Defensive: the strategy-level top-rung feasibility gate should already guarantee at
          // least one placeable rung: this only fires if market metadata changed between
          // decision and placement.
          logger.warn({ event: 'ladder.no_feasible_rungs', intentId: intent.id }, 'ladder.no_feasible_rungs')
          setError(s, 'ladder_no_fills', 'no ladder rungs met feasibility at placement')
          return s
        }

        transition(s, 'monitoring')
        monitor.arm(s)
        spawnLadderTracker(s, pAvgFull)

        return s
      }

      // ── Single limit entry ──────────────────────────────────────────────────────
      if (entryPolicy.kind === 'limit') {
        const clientOrderId = ids.forIntent(intent.id, 0)
        s.entryOrderId = clientOrderId
        const canonEntryId = canonicalize(intent.exchange, clientOrderId)
        byEntryOrderId.set(canonEntryId, intent.id)

        const limitPrice =
          intent.side === 'long'
            ? price * (1 - entryPolicy.priceOffsetPct / 100)
            : price * (1 + entryPolicy.priceOffsetPct / 100)

        s.entryLimitPrice = limitPrice

        if (opts.beforeCreateOrder) {
          try {
            await opts.beforeCreateOrder({
              intentId: intent.id,
              clientOrderId,
              exchange: intent.exchange,
              symbol: intent.exchangeSymbol,
              side: entrySide,
              kind: 'entry',
              orderType: 'limit',
              qty: check.qty,
              price: limitPrice,
              reduceOnly: false,
            })
          } catch (err) {
            logger.warn({ intentId: intent.id, err }, 'manager: durability write failed (limit entry)')
            bus.emit('ops.event', {
              ts: clock.now(),
              level: 'fatal',
              exchange: intent.exchange,
              eventType: 'durability_write_failed',
              payload: { intentId: intent.id, kind: 'entry', err: String(err) },
            })
          }
        }

        let ack
        try {
          ack = await withSubmissionGate(intent.exchange, () =>
            rest.createOrder({
              intentId: intent.id,
              clientOrderId,
              exchange: intent.exchange,
              symbol: intent.exchangeSymbol,
              side: entrySide,
              type: 'limit',
              qty: check.qty,
              price: limitPrice,
              leverage: intent.leverage,
            })
          )
        } catch (err) {
          byEntryOrderId.delete(canonEntryId)
          setError(s, 'create_order_failed', String(err))
          return s
        }

        if (ack.status === 'rejected') {
          byEntryOrderId.delete(canonEntryId)
          setError(s, 'order_rejected', ack.rejectReason ?? 'limit order rejected')
          return s
        }

        if (ack.exchangeOrderId) {
          s.entryExchangeOrderId = ack.exchangeOrderId
          byEntryExchangeOrderId.set(ack.exchangeOrderId, intent.id)
        }

        bus.emit('order.placed', {
          intentId: intent.id,
          exchange: intent.exchange,
          symbol: intent.symbol,
          clientOrderId,
          kind: 'entry',
          side: entrySide,
          orderType: 'limit',
          qty: check.qty,
          price: limitPrice,
          reduceOnly: false,
          ...(ack.exchangeOrderId ? { exchangeOrderId: ack.exchangeOrderId } : {}),
        })
        logger.info({ event: 'order.placed', intentId: intent.id, limitPrice, qty: check.qty }, 'order.placed (limit)')

        if (s.status === 'submitted') transition(s, 'acked')
        if (s.status === 'acked') transition(s, 'working')

        // Expiry timer: if limit never fills, cancel it and emit error.
        const delayToExpiry = Math.max(0, entryPolicy.expireAt - clock.now())
        setTimeout(() => {
          void (async () => {
            if (TERMINAL.has(s.status) || s.status === 'filled' || s.status === 'monitoring') return
            logger.info({ intentId: intent.id }, 'limit entry expired — cancelling unfilled limit')
            byEntryOrderId.delete(canonEntryId)
            if (ack.exchangeOrderId) byEntryExchangeOrderId.delete(ack.exchangeOrderId)
            try {
              await rest.cancelOrder({ symbol: intent.exchangeSymbol, clientOrderId })
            } catch {
              /* best effort */
            }
            if (s.filledQty > 0) {
              // Partially filled — proceed with what we got.
              transition(s, 'filled')
              await handleEntryFilled(s)
            } else {
              setError(s, 'limit_expired', 'limit order expired without any fill')
            }
          })()
        }, delayToExpiry)

        // REST poll fallback for limit fill detection.
        if (!TERMINAL.has(s.status) && s.status === 'working') {
          void pollForEntryFill(s, clientOrderId, ack.exchangeOrderId, rest)
        }

        return s
      }

      // ── Market entry (default) ───────────────────────────────────────────────────
      const clientOrderId = ids.forIntent(intent.id, 0)
      s.entryOrderId = clientOrderId
      const canonEntryId = canonicalize(intent.exchange, clientOrderId)

      // Register BEFORE placing so that any WS fill events that arrive during the REST
      // call (e.g. immediate market-order fill) are routed correctly. Use canonical form
      // so the incoming WS clientOrderId matches on exchanges that transform it (OKX).
      byEntryOrderId.set(canonEntryId, intent.id)

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
          bus.emit('ops.event', {
            ts: clock.now(),
            level: 'fatal',
            exchange: intent.exchange,
            eventType: 'durability_write_failed',
            payload: { intentId: intent.id, kind: 'entry', err: String(err) },
          })
        }
      }

      // Guard: intent may have been preempted during the durability write above (async yield).
      // Bail before placing to avoid orphan orders that must immediately be cancelled.
      if (s.status !== 'submitted') {
        byEntryOrderId.delete(canonEntryId)
        return s
      }

      // Emit order.placed before the REST call so log ordering is correct even when a WS fill
      // races back faster than the ACK (GateIO/OKX market orders). exchangeOrderId is absent until ACK.
      const placedAt = clock.now()
      const entryPlacedPre: OrderPlacedEvent = {
        intentId: intent.id,
        exchange: intent.exchange,
        symbol: intent.symbol,
        clientOrderId,
        kind: 'entry',
        side: entrySide,
        orderType: 'market',
        qty: check.qty,
        reduceOnly: false,
        ackPending: true,
      }
      bus.emit('order.placed', entryPlacedPre)
      logger.info({ event: 'order.placed', ...entryPlacedPre }, 'order.placed')

      let ack
      try {
        ack = await withSubmissionGate(intent.exchange, () =>
          createOrderWithOkxWsFallback(intent.strategy, {
            intentId: intent.id,
            clientOrderId,
            exchange: intent.exchange,
            symbol: intent.exchangeSymbol,
            side: entrySide,
            type: 'market',
            qty: check.qty,
            leverage: intent.leverage,
          })
        )
      } catch (err) {
        byEntryOrderId.delete(canonEntryId)
        setError(s, 'create_order_failed', String(err))
        return s
      }

      if (ack.status === 'rejected') {
        byEntryOrderId.delete(canonEntryId)
        setError(s, 'order_rejected', ack.rejectReason ?? 'order rejected')
        const rejectNow = clock.now()
        bus.emit('ws.order', {
          exchange: intent.exchange,
          seq: 0,
          receivedAt: rejectNow,
          order: {
            exchange: intent.exchange,
            symbol: intent.exchangeSymbol,
            clientOrderId,
            exchangeOrderId: ack.exchangeOrderId,
            side: entrySide,
            type: 'market',
            qty: check.qty,
            filledQty: 0,
            reduceOnly: false,
            status: 'rejected',
            ...(ack.rejectReason !== undefined ? { rejectReason: ack.rejectReason } : {}),
            submittedAt: rejectNow,
            updatedAt: rejectNow,
          },
        })
        return s
      }

      // Guard: intent may have been preempted while createOrder was in-flight (async await
      // yields allow concurrent submit() calls to call preemptSynchronously on this intent).
      // If status is no longer 'submitted', the intent is cancelled — cancel the placed order
      // best-effort and return without advancing state.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (s.status !== 'submitted') {
        // Legitimate pre-emption (filled/working/acked) is debug noise; only warn for truly orphaned states.
        const isLegitTerminal =
          s.status === 'filled' ||
          s.status === 'working' ||
          s.status === 'acked' ||
          s.status === 'monitoring' ||
          s.status === 'exiting' ||
          s.status === 'exited'
        logger[isLegitTerminal ? 'debug' : 'warn'](
          {
            event: 'market_entry.preempted_in_flight',
            intentId: intent.id,
            exchange: intent.exchange,
            status: s.status,
          },
          'market order placed but intent preempted in-flight — cancelling orphan order'
        )
        byEntryOrderId.delete(canonEntryId)
        if (ack.exchangeOrderId) {
          void rest
            .cancelOrder({ symbol: intent.exchangeSymbol, clientOrderId, exchangeOrderId: ack.exchangeOrderId })
            .catch((err: unknown) => {
              const code = (err as { code?: string }).code ?? String(err)
              const isCancelGone = new Set(['TEXT_DUPLICATED', 'ORDER_NOT_FOUND', 'ORDER_FINISHED']).has(code)
              logger[isCancelGone ? 'debug' : 'warn'](
                { intentId: intent.id, err },
                'market_entry: orphan cancel failed'
              )
            })
        }
        return s
      }

      // Register exchangeOrderId as fallback routing key (covers exchanges that omit
      // clientOrderId from WS market-order fill events, e.g. Bitget, KuCoin).
      if (ack.exchangeOrderId) {
        s.entryExchangeOrderId = ack.exchangeOrderId
        byEntryExchangeOrderId.set(ack.exchangeOrderId, intent.id)
        // Post-ACK emit to persist exchange_order_id in DB. The pre-ACK order.placed (above)
        // had no exchangeOrderId; this upsert sets it so ws.fill lookups by exchangeOrderId work
        // for exchanges (e.g. Binance) that may send empty clientOrderId in ORDER_TRADE_UPDATE.
        bus.emit('order.placed', { ...entryPlacedPre, exchangeOrderId: ack.exchangeOrderId, ackPending: false })
      }
      // Log the ACK with latency breakdown: placement_latency_ms (submit→placed) and ack_latency_ms (placed→acked).
      logger.info(
        {
          event: 'order.acked',
          intentId: intent.id,
          exchange: intent.exchange,
          symbol: intent.symbol,
          clientOrderId,
          ...(ack.exchangeOrderId ? { exchangeOrderId: ack.exchangeOrderId } : {}),
          placement_latency_ms: placedAt - s.intent.decidedAt,
          ack_latency_ms: clock.now() - placedAt,
        },
        'order.acked'
      )

      // TS narrows s.status to 'submitted' after the preemption guard above; alias through
      // the full union so status checks after each transition() mutation compile correctly.
      const ss = s as typeof s & { status: IntentStatus }

      // Only advance to acked/working if the WS handler hasn't already advanced
      // the state further (e.g. a market order that fills during the REST call).
      if (ss.status === 'submitted') transition(s, 'acked')
      if (ss.status === 'acked') transition(s, 'working')

      // Catch-up: in case a WS event arrived while the REST call was in flight
      // (market orders on OKX/Bitget/KuCoin fill immediately and emit WS with empty
      // clientOrderId before byEntryExchangeOrderId is registered).
      // Search by clientOrderId first, then exchangeOrderId from the ACK.
      if (!TERMINAL.has(ss.status) && ss.status === 'working') {
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
      if (!TERMINAL.has(ss.status) && ss.status === 'working') {
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
        await handleMonitorExit(s, 'kill_switch_flatten')
        return
      }

      if (['submitted', 'acked', 'working', 'partially_filled'].includes(s.status)) {
        if (s.ladderRungs && s.ladderRungs.length > 0) {
          // Cancel all unfilled ladder rungs.
          await Promise.allSettled(
            s.ladderRungs
              .filter(r => !r.filled)
              .map(r =>
                rest
                  .cancelOrder({ symbol: s.intent.exchangeSymbol, clientOrderId: r.clientOrderId })
                  .catch((err: unknown) => {
                    logger.warn(
                      { intentId: id, clientOrderId: r.clientOrderId, err },
                      'manager: cancelOrder failed (ladder rung)'
                    )
                  })
              )
          )
        } else if (s.entryOrderId) {
          try {
            await rest.cancelOrder({
              symbol: s.intent.exchangeSymbol,
              clientOrderId: s.entryOrderId,
            })
          } catch (err) {
            logger.warn({ intentId: id, err }, 'manager: cancelOrder failed')
          }
        }
      }

      // If the entry order had already partially filled, close the open position before going terminal
      if (s.filledQty > 0) {
        await handleMonitorExit(s, 'kill_switch_flatten')
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

    prewarmLeverage(exchange: Exchange, symbol: string, leverage: number): Promise<void> {
      const rest = restAdapters.get(exchange)
      if (!rest) return Promise.resolve()
      const market = opts.markets.get(exchange, symbol)
      if (!market) return Promise.resolve()
      return ensureLeverage(rest, exchange, market.exchangeSymbol, symbol, leverage).catch((err: unknown) => {
        logger.warn({ event: 'prewarm.leverage_failed', exchange, symbol, leverage, err }, 'prewarmLeverage failed')
      })
    },

    listOpenIntents(): { intentId: string; exchange: Exchange; symbol: string }[] {
      const result: { intentId: string; exchange: Exchange; symbol: string }[] = []
      for (const [id, s] of intentStates) {
        if (!TERMINAL.has(s.status)) {
          result.push({ intentId: id, exchange: s.intent.exchange, symbol: s.intent.symbol })
        }
      }
      return result
    },

    listRecentIntentsForAttribution(maxAgeMs: number): { intentId: string; exchange: Exchange; symbol: string }[] {
      const cutoff = clock.now() - maxAgeMs
      const result: { intentId: string; exchange: Exchange; symbol: string }[] = []
      for (const [id, s] of intentStates) {
        if (!TERMINAL.has(s.status)) {
          result.push({ intentId: id, exchange: s.intent.exchange, symbol: s.intent.symbol })
        } else if (s.updatedAt >= cutoff) {
          result.push({ intentId: id, exchange: s.intent.exchange, symbol: s.intent.symbol })
        }
      }
      return result
    },
  }
}
