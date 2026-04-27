import { vi } from 'vitest'

import { makeTypedEmitter } from '../adapters/privatews/binance-client.js'
import type {
  BinanceRawFuturesMessage,
  BinanceWsClient,
  BinanceWsClientEvents,
} from '../adapters/privatews/binance-client.js'

export interface FakeBinanceWsClient extends BinanceWsClient {
  emit: {
    close: (reason?: string) => void
    error: (err?: Error) => void
    message: (data: BinanceRawFuturesMessage) => void
    listenKeyExpired: () => void
  }
}

export function createFakeBinanceWsClient(): FakeBinanceWsClient {
  const eventsImpl = makeTypedEmitter<BinanceWsClientEvents>()

  return {
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    disconnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    events: eventsImpl,
    emit: {
      close: (reason = 'test close') => {
        eventsImpl.emit('close', reason)
      },
      error: (err = new Error('test error')) => {
        eventsImpl.emit('error', err)
      },
      message: (data: BinanceRawFuturesMessage) => {
        eventsImpl.emit('message', data)
      },
      listenKeyExpired: () => {
        eventsImpl.emit('listenKeyExpired')
      },
    },
  }
}
