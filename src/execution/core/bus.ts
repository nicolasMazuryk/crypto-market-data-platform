import { EventEmitter } from 'node:events'

import type { Unsubscribe } from '../types/exchange.js'
import type { DomainEvents, EventBus } from './types.js'

type AnyListener = (...args: unknown[]) => void

export function createEventBus(): EventBus {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)

  return {
    on(event, listener) {
      emitter.on(event, listener as AnyListener)
      const unsubscribe: Unsubscribe = () => {
        emitter.off(event, listener as AnyListener)
      }
      return unsubscribe
    },
    off(event, listener) {
      emitter.off(event, listener as AnyListener)
    },
    emit<K extends keyof DomainEvents>(event: K, ...args: DomainEvents[K] extends (...a: infer A) => void ? A : never) {
      emitter.emit(event, ...(args as unknown[]))
    },
  }
}
