import { EventEmitter } from 'node:events'

import type { WebsocketClient as BinanceWebsocketClient } from 'binance'

import type { TypedEventEmitter, Unsubscribe } from '../../types/exchange.js'

export interface BinanceRawFuturesMessage {
  e: string
  E: number
  [key: string]: unknown
}

export interface BinanceWsClientEvents {
  close: (reason: string) => void
  error: (err: Error) => void
  message: (data: BinanceRawFuturesMessage) => void
  listenKeyExpired: () => void
}

export interface BinanceWsClient {
  connect(): Promise<void>
  disconnect(): Promise<void>
  readonly events: TypedEventEmitter<BinanceWsClientEvents>
}

export type BinanceWsClientFactory = () => BinanceWsClient

export interface BinanceWsCredentials {
  apiKey: string
  apiSecret: string
  apiPassphrase?: string
}

export interface BinanceWsClientOptions {
  credentials?: BinanceWsCredentials
  wsBaseUrl?: string
}

type AnyListener = (...args: unknown[]) => void

function makeTypedEmitter<T>(): TypedEventEmitter<T> {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  return {
    on<K extends keyof T & string>(
      event: K,
      listener: T[K] extends (...a: infer A) => void ? (...a: A) => void : never
    ): Unsubscribe {
      emitter.on(event, listener as AnyListener)
      return () => emitter.off(event, listener as AnyListener)
    },
    off<K extends keyof T & string>(
      event: K,
      listener: T[K] extends (...a: infer A) => void ? (...a: A) => void : never
    ): void {
      emitter.off(event, listener as AnyListener)
    },
    emit<K extends keyof T & string>(event: K, ...args: T[K] extends (...a: infer A) => void ? A : never): void {
      emitter.emit(event, ...(args as unknown[]))
    },
  }
}

export { makeTypedEmitter }

export function createBinanceWsClient(opts: BinanceWsClientOptions): BinanceWsClient {
  const emitter = makeTypedEmitter<BinanceWsClientEvents>()

  let sdkClient: BinanceWebsocketClient | null = null

  return {
    async connect(): Promise<void> {
      const { WebsocketClient } = await import('binance')
      const clientOpts: Record<string, unknown> = { beautify: false }
      if (opts.credentials) {
        clientOpts.api_key = opts.credentials.apiKey
        clientOpts.api_secret = opts.credentials.apiSecret
      }
      if (opts.wsBaseUrl) {
        clientOpts.wsUrl = opts.wsBaseUrl
      }

      sdkClient = new WebsocketClient(clientOpts as ConstructorParameters<typeof WebsocketClient>[0])

      sdkClient.on('exception', evt => {
        const wsKey = (evt as Record<string, unknown>).wsKey
        if (wsKey !== 'usdmPrivate') return
        const rawErr = (evt as Record<string, unknown>).error
        const errMsg = typeof rawErr === 'string' ? rawErr : rawErr instanceof Error ? rawErr.message : 'unknown error'
        emitter.emit('error', new Error(errMsg))
      })

      sdkClient.on('close', evt => {
        const wsKey = (evt as Record<string, unknown>).wsKey
        if (wsKey !== 'usdmPrivate') return
        emitter.emit('close', 'connection closed')
      })

      sdkClient.on('message', data => {
        if (typeof data !== 'object') return
        const msg = data as unknown as BinanceRawFuturesMessage
        if (typeof msg.e !== 'string') return
        if (msg.e === 'listenKeyExpired') {
          emitter.emit('listenKeyExpired')
        } else {
          emitter.emit('message', msg)
        }
      })

      const result = await sdkClient.subscribeUsdFuturesUserDataStream()
      if (!result) {
        throw new Error('Failed to subscribe to USD futures user data stream')
      }
    },

    async disconnect(): Promise<void> {
      const client = sdkClient
      sdkClient = null
      if (client) {
        client.removeAllListeners()
        try {
          await client.unsubscribeUsdFuturesUserDataStream()
        } catch {
          // ignore
        }
        try {
          // Force-close all sockets and clear WS-level timers (clearTimers per wsKey).
          // Does not fix the listenKey keep-alive setInterval leak in the binance package
          // (teardownUserDataListenKey is not exposed), but closes auxiliary connections
          // and is safe to call even after unsubscribe.
          client.closeAll(true)
        } catch {
          // ignore
        }
      }
    },

    events: emitter,
  }
}
