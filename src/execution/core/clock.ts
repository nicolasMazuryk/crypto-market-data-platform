import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'

import type { Exchange, Unsubscribe } from '../types/exchange.js'
import type { Clock } from './types.js'

const SKEW_BREACH_MS = 300

export interface SkewBreach {
  exchange: Exchange
  skewMs: number
  at: number
}

export interface ExecutionClock extends Clock {
  onSkewBreach(listener: (breach: SkewBreach) => void): Unsubscribe
}

export function createClock(): ExecutionClock {
  const skew = new Map<Exchange, number>()
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)

  return {
    now: () => Date.now(),
    monotonic: () => performance.now(),
    skewMs(exchange) {
      return skew.get(exchange) ?? 0
    },
    recordSkew(exchange, serverTime, localTime) {
      const delta = serverTime - localTime
      skew.set(exchange, delta)
      if (Math.abs(delta) > SKEW_BREACH_MS) {
        const breach: SkewBreach = { exchange, skewMs: delta, at: Date.now() }
        emitter.emit('skew.breach', breach)
      }
    },
    onSkewBreach(listener) {
      emitter.on('skew.breach', listener)
      return () => emitter.off('skew.breach', listener)
    },
  }
}
