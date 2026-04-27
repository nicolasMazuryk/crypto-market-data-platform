import type { Exchange } from '../../types/exchange.js'
import { makeTypedEmitter } from './binance-client.js'
import type { ExchangePrivateWsAdapter, PrivateWsEvents } from './types.js'

export function createShadowPrivateWsAdapter(exchange: Exchange): ExchangePrivateWsAdapter {
  return {
    exchange,
    async connect(): Promise<void> {
      // shadow adapter: no-op
    },
    async disconnect(): Promise<void> {
      // shadow adapter: no-op
    },
    events: makeTypedEmitter<PrivateWsEvents>(),
  }
}
