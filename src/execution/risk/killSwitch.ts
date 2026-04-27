import type { Logger } from 'pino'

import type { EngineMode, KillSwitch, KillSwitchState } from './types.js'

export function createKillSwitch(logger: Logger, initialMode: EngineMode = 'dry_run'): KillSwitch {
  let state: KillSwitchState = { mode: initialMode }
  let flattenHandler: (() => Promise<void>) | undefined

  return {
    state: () => ({ ...state }),
    trip: (reason: string) => {
      state = { mode: 'halted', trippedAt: Date.now(), reason }
      logger.warn({ reason }, 'kill switch tripped')
      return Promise.resolve()
    },
    setMode: (mode: EngineMode, reason?: string) => {
      state = reason === undefined ? { mode } : { mode, reason }
      logger.info({ mode, reason }, 'kill switch mode changed')
      return Promise.resolve()
    },
    flattenAll: () => {
      if (flattenHandler) {
        logger.warn('kill switch: flattenAll — delegating to manager')
        return flattenHandler()
      }
      logger.warn('kill switch: flattenAll called but no handler registered')
      return Promise.resolve()
    },
    canPlaceOrder: () => state.mode === 'live' || state.mode === 'dry_run',
    wireFlattener: (fn: () => Promise<void>) => {
      flattenHandler = fn
    },
  }
}
