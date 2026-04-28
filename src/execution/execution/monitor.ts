import type { Logger } from 'pino'

import type { Clock, EventBus } from '../core/types.js'
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

      if (exitPolicy.kind === 'timed') {
        const delay = Math.max(0, exitPolicy.exitAt - now - skewMs)
        let fired = false
        const handle = setTOFn(() => {
          if (!fired && armed.has(intentId)) {
            fired = true
            doDisarm(intentId)
            emitExit(intentId, 'timed')
          }
        }, delay)
        entry.timers.push(handle)
        logger.debug({ intentId, delay }, 'monitor.armed.timed')
      } else {
        // sl_tp_deadline
        const slId = state.exitOrderRefs?.sl?.clientOrderId
        const tpId = state.exitOrderRefs?.tp?.clientOrderId

        let settled = false

        const settle = (reason: ExitReason, triggerOrderId?: string): void => {
          if (!settled) {
            settled = true
            doDisarm(intentId)
            logger.info({ intentId, reason, triggerOrderId }, 'monitor.settle')
            emitExit(intentId, reason)
          }
        }

        const deadlineDelay = Math.max(0, exitPolicy.deadlineAt - now - skewMs)
        const deadlineHandle = setTOFn(() => {
          logger.info({ intentId, deadlineAt: exitPolicy.deadlineAt }, 'monitor.deadline_fired')
          settle('deadline')
        }, deadlineDelay)
        entry.timers.push(deadlineHandle)

        const unsub = bus.on('ws.order', event => {
          if (event.exchange !== intent.exchange) return
          const { order } = event
          if (order.status !== 'filled') return
          if (order.clientOrderId === slId) {
            settle('sl', order.clientOrderId)
          } else if (order.clientOrderId === tpId) {
            settle('tp', order.clientOrderId)
          }
        })
        entry.unsubs.push(unsub)

        logger.debug({ intentId, deadlineDelay, slId, tpId }, 'monitor.armed.sl_tp_deadline')
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
