import { EventEmitter } from 'node:events'
import * as https from 'node:https'
import * as http from 'node:http'

import WebSocket from 'ws'

import type { TypedEventEmitter, Unsubscribe } from '../../types/exchange.js'

// ─── Public types (interface unchanged for callers) ──────────────────────────

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
  /** Override WS base URL (e.g. for testnet: wss://stream.binancefuture.com) */
  wsBaseUrl?: string
  /** Override REST base URL for listenKey management (defaults to https://fapi.binance.com) */
  restBaseUrl?: string
}

// ─── Internal helpers ────────────────────────────────────────────────────────

type AnyListener = (...args: unknown[]) => void

export function makeTypedEmitter<T>(): TypedEventEmitter<T> {
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

// ─── REST helpers for listenKey lifecycle ────────────────────────────────────

// Binance listenKey TTL is 60 min; we keep-alive at 30 min and rotate the key at 50 min
// to prevent expiry without ever holding a stale key for a full hour.
const KEEPALIVE_INTERVAL_MS = 30 * 60 * 1_000
const ROTATION_INTERVAL_MS = 50 * 60 * 1_000
const ROTATION_OVERLAP_MS = 30 * 1_000

function httpsRequest(method: 'POST' | 'PUT' | 'DELETE', url: string, apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
      path: parsed.pathname + parsed.search,
      method,
      headers: { 'X-MBX-APIKEY': apiKey },
    }
    const req = mod.request(options, res => {
      let body = ''
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => {
        resolve(body)
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function createListenKey(restBase: string, apiKey: string): Promise<string> {
  const raw = await httpsRequest('POST', `${restBase}/fapi/v1/listenKey`, apiKey)
  const parsed = JSON.parse(raw) as { listenKey?: string; msg?: string }
  if (!parsed.listenKey) throw new Error(`Binance listenKey create failed: ${parsed.msg ?? raw}`)
  return parsed.listenKey
}

async function keepaliveListenKey(restBase: string, apiKey: string, listenKey: string): Promise<void> {
  await httpsRequest('PUT', `${restBase}/fapi/v1/listenKey?listenKey=${encodeURIComponent(listenKey)}`, apiKey)
}

function deleteListenKey(restBase: string, apiKey: string, listenKey: string): void {
  httpsRequest('DELETE', `${restBase}/fapi/v1/listenKey?listenKey=${encodeURIComponent(listenKey)}`, apiKey).catch(
    () => {
      /* best-effort cleanup */
    }
  )
}

// ─── Main factory ────────────────────────────────────────────────────────────

export function createBinanceWsClient(opts: BinanceWsClientOptions): BinanceWsClient {
  const emitter = makeTypedEmitter<BinanceWsClientEvents>()
  const wsBase = opts.wsBaseUrl ?? 'wss://fstream.binance.com'
  const restBase = opts.restBaseUrl ?? 'https://fapi.binance.com'
  const apiKey = opts.credentials?.apiKey ?? ''

  let activeSocket: WebSocket | null = null
  let activeKey: string | null = null
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  let rotationTimer: ReturnType<typeof setInterval> | null = null
  let disconnected = false

  function attachSocketHandlers(ws: WebSocket): void {
    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const text = raw instanceof Buffer ? raw.toString() : String(raw)
        const msg = JSON.parse(text) as BinanceRawFuturesMessage
        if (typeof msg.e !== 'string') return
        if (msg.e === 'listenKeyExpired') {
          emitter.emit('listenKeyExpired')
          void rotateKey()
        } else {
          emitter.emit('message', msg)
        }
      } catch {
        // ignore malformed frames
      }
    })

    ws.on('close', () => {
      if (!disconnected) emitter.emit('close', 'connection closed')
    })

    ws.on('error', (err: Error) => {
      emitter.emit('error', err)
    })
  }

  function openSocket(listenKey: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/ws/${listenKey}`)
      ws.once('open', () => {
        resolve(ws)
      })
      ws.once('error', reject)
    })
  }

  async function rotateKey(): Promise<void> {
    if (disconnected || !apiKey) return
    try {
      const newKey = await createListenKey(restBase, apiKey)
      const newSocket = await openSocket(newKey)
      attachSocketHandlers(newSocket)

      const oldSocket = activeSocket
      const oldKey = activeKey
      activeSocket = newSocket
      activeKey = newKey

      // Brief overlap so in-flight events on the old key are not lost
      await new Promise<void>(resolve => setTimeout(resolve, ROTATION_OVERLAP_MS))

      if (oldSocket) {
        oldSocket.removeAllListeners()
        oldSocket.close()
      }
      if (oldKey) deleteListenKey(restBase, apiKey, oldKey)
    } catch (err) {
      emitter.emit('error', err instanceof Error ? err : new Error(String(err)))
    }
  }

  function startTimers(): void {
    if (!apiKey) return
    keepaliveTimer = setInterval(() => {
      if (activeKey) {
        keepaliveListenKey(restBase, apiKey, activeKey).catch((err: unknown) => {
          emitter.emit('error', err instanceof Error ? err : new Error(String(err)))
        })
      }
    }, KEEPALIVE_INTERVAL_MS)

    rotationTimer = setInterval(() => {
      void rotateKey()
    }, ROTATION_INTERVAL_MS)
  }

  function clearTimers(): void {
    if (keepaliveTimer !== null) {
      clearInterval(keepaliveTimer)
      keepaliveTimer = null
    }
    if (rotationTimer !== null) {
      clearInterval(rotationTimer)
      rotationTimer = null
    }
  }

  return {
    async connect(): Promise<void> {
      disconnected = false
      if (!apiKey) return // no-credentials mode (test/mock)

      activeKey = await createListenKey(restBase, apiKey)
      const ws = await openSocket(activeKey)
      attachSocketHandlers(ws)
      activeSocket = ws
      startTimers()
    },

    disconnect(): Promise<void> {
      disconnected = true
      clearTimers()
      const ws = activeSocket
      const key = activeKey
      activeSocket = null
      activeKey = null
      if (ws) {
        ws.removeAllListeners()
        ws.close()
      }
      if (key) deleteListenKey(restBase, apiKey, key)
      return Promise.resolve()
    },

    events: emitter,
  }
}
