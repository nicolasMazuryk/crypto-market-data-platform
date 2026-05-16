import type { Logger } from 'pino'

import type { Clock, EventBus, ExitTriggeredEvent } from '../core/types.js'
import type { ExecutionMetrics } from '../observability/metrics.js'
import type { Unsubscribe } from '../types/exchange.js'
import type { ExitReason, IntentState, PositionMonitor } from './types.js'

export interface PositionMonitorOptions {
  bus: EventBus
  clock: Clock
  logger: Logger
  metrics: ExecutionMetrics
  setTimeoutFn?: (cb: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
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
  source: 'ws' | 'timer'
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
        const timeoutHandle = setTOFn(() => {
          settle('funding_fee_timeout', {
            triggerTs: clock.now(),
            source: 'timer',
            latencyMs: Math.max(0, clock.now() - timeoutAt),
          })
        }, timeoutDelay)
        entry.timers.push(timeoutHandle)

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

        logger.debug({ intentId, timeoutDelay, fundingTs }, 'monitor.armed.funding_fee_event')
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
