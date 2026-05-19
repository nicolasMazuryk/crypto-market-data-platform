import type { Logger } from 'pino'

import type { Clock, EventBus, ExitTriggeredEvent } from '../core/types.js'
import type { ExecutionMetrics } from '../observability/metrics.js'
import type { Unsubscribe, Exchange } from '../types/exchange.js'
import type { ExitReason, IntentState, PositionMonitor } from './types.js'
import type { FundingFeeEvent } from '../adapters/privatews/types.js'

export type RestFundingFeePoller = (params: {
  exchange: Exchange
  symbol: string
  fundingTs: number
}) => Promise<FundingFeeEvent | null>

export interface PositionMonitorOptions {
  bus: EventBus
  clock: Clock
  logger: Logger
  metrics: ExecutionMetrics
  setTimeoutFn?: (cb: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
  restFundingFeePoller?: RestFundingFeePoller
}

export interface PositionMonitorHandle extends PositionMonitor {
  stop(): void
}

interface ArmedEntry {
  timers: unknown[]
  unsubs: Unsubscribe[]
}

interface ExitTriggerContext {
  triggerPrice?: number
  triggerTs: number
  source: 'ws' | 'timer' | 'rest_poll'
  exitOrderClientId?: string
  latencyMs?: number
}

export function createPositionMonitor(opts: PositionMonitorOptions): PositionMonitorHandle {
  const { bus, clock, logger } = opts
  const setTOFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTOFn =
    opts.clearTimeoutFn ??
    (h => {
      clearTimeout(h as ReturnType<typeof setTimeout>)
    })

  const armed = new Map<string, ArmedEntry>()
  const exitListeners = new Set<(intentId: string, reason: ExitReason) => void>()

  function emitExit(intentId: string, reason: ExitReason): void {
    logger.info({ intentId, reason }, 'monitor.exit_requested')
    for (const listener of exitListeners) {
      listener(intentId, reason)
    }
  }

  function doDisarm(intentId: string): void {
    const entry = armed.get(intentId)
    if (!entry) return
    for (const t of entry.timers) clearTOFn(t)
    for (const unsub of entry.unsubs) unsub()
    armed.delete(intentId)
  }

  return {
    arm(state: IntentState): void {
      const { intent } = state
      const { exitPolicy } = intent
      const intentId = intent.id

      doDisarm(intentId)

      const entry: ArmedEntry = { timers: [], unsubs: [] }
      armed.set(intentId, entry)

      const now = clock.now()
      const skewMs = clock.skewMs(intent.exchange)

      let settled = false
      let fundingGateOpen = false

      const settle = (reason: ExitReason, ctx: ExitTriggerContext): void => {
        if (settled) return
        settled = true
        if (!armed.has(intentId)) return
        doDisarm(intentId)
        const triggerEvent: ExitTriggeredEvent = {
          intentId,
          exchange: intent.exchange,
          symbol: intent.symbol,
          reason,
          triggerTs: ctx.triggerTs,
          source: ctx.source,
          ...(ctx.triggerPrice !== undefined ? { triggerPrice: ctx.triggerPrice } : {}),
          ...(ctx.exitOrderClientId !== undefined ? { exitOrderClientId: ctx.exitOrderClientId } : {}),
          ...(ctx.latencyMs !== undefined ? { latencyMs: ctx.latencyMs } : {}),
        }
        bus.emit('exit.triggered', triggerEvent)
        if (fundingGateOpen) {
          bus.emit('intent.funding_gate_closed', { intentId, reason })
          logger.info({ intentId, reason }, 'monitor.funding_gate_closed')
          fundingGateOpen = false
        }
        logger.info({ intentId, reason, ...ctx }, 'monitor.settle')
        emitExit(intentId, reason)
      }

      if (exitPolicy.kind === 'timed') {
        const delay = Math.max(0, exitPolicy.exitAt - now - skewMs)
        const handle = setTOFn(() => {
          settle('timed', {
            triggerTs: clock.now(),
            source: 'timer',
            latencyMs: Math.max(0, clock.now() - exitPolicy.exitAt),
          })
        }, delay)
        entry.timers.push(handle)
        logger.debug({ intentId, delay }, 'monitor.armed.timed')
      } else if (exitPolicy.kind === 'sl_tp_deadline' || exitPolicy.kind === 'sl_tp_deadline_post_funding_event') {
        const slId = state.exitOrderRefs?.sl?.clientOrderId
        const tpId = state.exitOrderRefs?.tp?.clientOrderId
        const slExchangeId = state.exitOrderRefs?.sl?.exchangeOrderId
        const tpExchangeId = state.exitOrderRefs?.tp?.exchangeOrderId

        const deadlineDelay = Math.max(0, exitPolicy.deadlineAt - now - skewMs)
        const deadlineHandle = setTOFn(() => {
          logger.info({ intentId, deadlineAt: exitPolicy.deadlineAt }, 'monitor.deadline_fired')
          settle('deadline', {
            triggerTs: clock.now(),
            source: 'timer',
            latencyMs: Math.max(0, clock.now() - exitPolicy.deadlineAt),
          })
        }, deadlineDelay)
        entry.timers.push(deadlineHandle)

        const unsub = bus.on('ws.order', event => {
          if (event.exchange !== intent.exchange) return
          const { order } = event
          if (order.status !== 'filled') return
          const matchesSl =
            (slId && order.clientOrderId === slId) ||
            (slExchangeId && order.exchangeOrderId === slExchangeId)
          const matchesTp =
            (tpId && order.clientOrderId === tpId) ||
            (tpExchangeId && order.exchangeOrderId === tpExchangeId)
          if (matchesSl) {
            const ctx: ExitTriggerContext = {
              triggerTs: order.updatedAt,
              source: 'ws',
              ...(slId !== undefined ? { exitOrderClientId: slId } : {}),
              latencyMs: event.receivedAt - order.updatedAt,
            }
            if (order.avgFillPrice !== undefined) ctx.triggerPrice = order.avgFillPrice
            settle('sl', ctx)
          } else if (matchesTp) {
            const ctx: ExitTriggerContext = {
              triggerTs: order.updatedAt,
              source: 'ws',
              ...(tpId !== undefined ? { exitOrderClientId: tpId } : {}),
              latencyMs: event.receivedAt - order.updatedAt,
            }
            if (order.avgFillPrice !== undefined) ctx.triggerPrice = order.avgFillPrice
            settle('tp', ctx)
          }
        })
        entry.unsubs.push(unsub)

        logger.debug({ intentId, deadlineDelay, slId, tpId }, 'monitor.armed.sl_tp_deadline')
      } else if (exitPolicy.kind === 'sl_tp_deadline_retracement' || exitPolicy.kind === 'sl_tp_deadline_retracement_funding_event') {
        // TP is a dynamic retracement order managed by the execution manager's tracker;
        // the tracker handles its own TP fill detection and calls monitor.disarm() + exit handler.
        const slId = state.exitOrderRefs?.sl?.clientOrderId
        const slExchangeId = state.exitOrderRefs?.sl?.exchangeOrderId

        const deadlineDelay = Math.max(0, exitPolicy.deadlineAt - now - skewMs)
        const deadlineHandle = setTOFn(() => {
          logger.info({ intentId, deadlineAt: exitPolicy.deadlineAt }, 'monitor.deadline_fired')
          settle('deadline', {
            triggerTs: clock.now(),
            source: 'timer',
            latencyMs: Math.max(0, clock.now() - exitPolicy.deadlineAt),
          })
        }, deadlineDelay)
        entry.timers.push(deadlineHandle)

        const unsub = bus.on('ws.order', event => {
          if (event.exchange !== intent.exchange) return
          const { order } = event
          const matchesSl =
            order.status === 'filled' &&
            ((slId && order.clientOrderId === slId) ||
              (slExchangeId && order.exchangeOrderId === slExchangeId))
          if (!matchesSl) return
          const ctx: ExitTriggerContext = {
            triggerTs: order.updatedAt,
            source: 'ws',
            ...(slId !== undefined ? { exitOrderClientId: slId } : {}),
            latencyMs: event.receivedAt - order.updatedAt,
          }
          if (order.avgFillPrice !== undefined) ctx.triggerPrice = order.avgFillPrice
          settle('sl', ctx)
        })
        entry.unsubs.push(unsub)

        logger.debug({ intentId, deadlineDelay, slId }, 'monitor.armed.sl_tp_deadline_retracement')
      } else {
        // funding_fee_event: exit on the WS funding-fee credit; fall back to a hard timeout.
        const { fundingTs, timeoutAt } = exitPolicy
        // Allow ±5 s drift between the expected fundingTs and the actual event timestamp.
        const toleranceMs = 5_000

        const timeoutDelay = Math.max(0, timeoutAt - now - skewMs)

        const unsub = bus.on('ws.funding_fee', event => {
          if (event.exchange !== intent.exchange) return
          if (event.symbol !== intent.symbol) return
          if (event.fundingTime < fundingTs - toleranceMs || event.fundingTime > fundingTs + toleranceMs) return
          settle('funding_fee', {
            triggerTs: event.receivedAt,
            source: 'ws',
            latencyMs: event.receivedAt - event.fundingTime,
          })
        })
        entry.unsubs.push(unsub)

        bus.emit('intent.funding_gate_opened', { intentId })
        logger.info({ intentId, fundingTs }, 'monitor.funding_gate_opened')
        fundingGateOpen = true

        // REST fallback: poll REST 3s after funding boundary. Register BEFORE the timeout timer
        // so that when both delays are 0 (late entry), the REST poll fires first in the event loop.
        const REST_POLL_DELAY_MS = 3_000
        // When monitoring starts after the funding boundary (late entry), both delays collapse to 0.
        // Give REST poll a head-start by deferring the timeout by REST_POLL_GRACE_MS so the async
        // REST call can complete before the timeout settles the intent.
        const REST_POLL_GRACE_MS = 8_000
        let restPollDelay: number | undefined
        if (opts.restFundingFeePoller) {
          restPollDelay = Math.max(0, fundingTs + REST_POLL_DELAY_MS - now - skewMs)
          const restPollHandle = setTOFn(() => {
            void opts.restFundingFeePoller!({ exchange: intent.exchange, symbol: intent.symbol, fundingTs })
              .then(fee => {
                if (fee) {
                  logger.info({ intentId, symbol: intent.symbol, fundingTs, fundingAmount: fee.fundingAmount }, 'monitor.rest_funding_fee_poll.found')
                  settle('funding_fee', {
                    triggerTs: fee.receivedAt,
                    source: 'rest_poll',
                    latencyMs: fee.receivedAt - fee.fundingTime,
                  })
                  bus.emit('ws.funding_fee', fee)
                } else {
                  logger.warn({ intentId, symbol: intent.symbol, fundingTs }, 'monitor.rest_funding_fee_poll.not_found')
                }
              })
              .catch((err: unknown) => {
                logger.warn({ intentId, err }, 'monitor.rest_funding_fee_poll.error')
              })
          }, restPollDelay)
          entry.timers.push(restPollHandle)
        }

        // If REST poller is active and timeout is already expired (late entry), add grace period
        // so the REST poll has time to complete before the timeout fires.
        const effectiveTimeoutDelay =
          opts.restFundingFeePoller && timeoutDelay === 0 ? REST_POLL_GRACE_MS : timeoutDelay
        const timeoutHandle = setTOFn(() => {
          settle('funding_fee_timeout', {
            triggerTs: clock.now(),
            source: 'timer',
            latencyMs: Math.max(0, clock.now() - timeoutAt),
          })
        }, effectiveTimeoutDelay)
        entry.timers.push(timeoutHandle)

        logger.debug({ intentId, timeoutDelay, effectiveTimeoutDelay, restPollDelay, fundingTs }, 'monitor.armed.funding_fee_event')
      }
    },

    disarm(intentId: string): void {
      doDisarm(intentId)
    },

    onExitRequested(listener: (intentId: string, reason: ExitReason) => void): Unsubscribe {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },

    stop(): void {
      for (const intentId of Array.from(armed.keys())) {
        doDisarm(intentId)
      }
      exitListeners.clear()
    },
  }
}
