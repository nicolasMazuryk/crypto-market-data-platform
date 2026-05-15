import { EventEmitter } from 'node:events'
import type { Logger } from 'pino'

import type { Clock, EventBus } from '../../core/types.js'
import type { ExchangeConfig, ExchangeCredentials } from '../../config/types.js'
import type { PrivateWsMetrics } from '../../observability/metrics.js'
import type { Exchange, TypedEventEmitter, Unsubscribe } from '../../types/exchange.js'
import { jitteredBackoff } from './backoff.js'
import { makeTypedEmitter } from './binance-client.js'
import type {
  ConnectionState,
  ConnectionStateEvent,
  ExchangePrivateWsAdapter,
  PrivateWsEvents,
  OrderEvent,
  PositionEvent,
  BalanceEvent,
  FillEvent,
  FundingFeeEvent,
} from './types.js'

export interface PrivateWsClientEvents {
  close: (reason: string) => void
  error: (err: Error) => void
  message: (raw: unknown) => void
  authExpired: () => void
}

export interface PrivateWsClient {
  connect(): Promise<void>
  disconnect(): Promise<void>
  readonly events: TypedEventEmitter<PrivateWsClientEvents>
}

export interface ParsedWsMessage {
  orders?: OrderEvent[]
  positions?: PositionEvent[]
  balances?: BalanceEvent[]
  fills?: FillEvent[]
  fundingFees?: FundingFeeEvent[] | undefined
  eventType: string
  eventTimestampMs?: number
}

export interface PrivateWsAdapterSpec<TRaw = unknown> {
  exchange: Exchange
  createClient(config: ExchangeConfig & { credentials?: ExchangeCredentials }): PrivateWsClient
  parseMessage(raw: TRaw, receivedAt: number, seq: number): ParsedWsMessage
}

export interface PrivateWsAdapterOptions {
  config: ExchangeConfig & { credentials?: ExchangeCredentials }
  bus: EventBus
  clock: Clock
  logger: Logger
  metrics: PrivateWsMetrics
}

const MAX_RETRIES = 10

function connStateNum(s: ConnectionState | 'idle'): number {
  switch (s) {
    case 'connecting':
      return 1
    case 'connected':
      return 2
    case 'reconnecting':
      return 3
    case 'fatal':
      return 4
    default:
      return 0
  }
}

export function createPrivateWsAdapterFromSpec<TRaw>(
  spec: PrivateWsAdapterSpec<TRaw>,
  opts: PrivateWsAdapterOptions
): ExchangePrivateWsAdapter {
  const { bus, clock, logger, metrics } = opts
  const exchange = spec.exchange

  let state: ConnectionState | 'idle' = 'idle'
  let retries = 0
  let disconnectRequested = false
  // Per-adapter (per-exchange) counter — seq from two adapters are independent and must not be compared across exchanges.
  let seq = 0
  let currentClient: PrivateWsClient | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectScheduled = false
  let connectionToken = 0
  let disconnectedAt: number | null = null

  type AnyListener = (...args: unknown[]) => void
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)

  const events: TypedEventEmitter<PrivateWsEvents> = {
    on<K extends keyof PrivateWsEvents>(
      event: K,
      listener: PrivateWsEvents[K] extends (...a: infer A) => void ? (...a: A) => void : never
    ): Unsubscribe {
      emitter.on(event, listener as AnyListener)
      return () => emitter.off(event, listener as AnyListener)
    },
    off<K extends keyof PrivateWsEvents>(
      event: K,
      listener: PrivateWsEvents[K] extends (...a: infer A) => void ? (...a: A) => void : never
    ): void {
      emitter.off(event, listener as AnyListener)
    },
    emit<K extends keyof PrivateWsEvents>(
      event: K,
      ...args: PrivateWsEvents[K] extends (...a: infer A) => void ? A : never
    ): void {
      emitter.emit(event, ...(args as unknown[]))
    },
  }

  function nextSeq(): number {
    return ++seq
  }

  function emitConnState(s: ConnectionState, reason?: string): void {
    const prevState = state
    const now = clock.now()

    // Track downtime window.
    if ((s === 'disconnected' || s === 'reconnecting') && disconnectedAt === null) {
      disconnectedAt = now
    }
    let downtimeMs: number | null = null
    if (s === 'connected' && disconnectedAt !== null) {
      downtimeMs = now - disconnectedAt
      disconnectedAt = null
    }

    state = s
    const ev: ConnectionStateEvent = {
      exchange,
      state: s,
      at: now,
      ...(reason !== undefined ? { reason } : {}),
    }
    events.emit('connectionState', ev)
    bus.emit('ws.connection', ev)
    metrics.connectionState.set(connStateNum(s), { exchange })
    logger.info(
      {
        event: 'ws.connection',
        exchange,
        state: s,
        prevState,
        downtimeMs,
        ...(reason !== undefined ? { reason } : {}),
      },
      'ws.connection'
    )
  }

  function scheduleReconnect(): void {
    if (disconnectRequested || state === 'fatal' || reconnectScheduled) return

    if (retries >= MAX_RETRIES) {
      emitConnState('fatal', 'retries exhausted')
      return
    }

    reconnectScheduled = true
    const delay = jitteredBackoff(retries)
    retries++
    metrics.reconnectTotal.inc(1, { exchange })

    reconnectTimer = setTimeout(() => {
      reconnectScheduled = false
      reconnectTimer = null
      if (disconnectRequested) return
      void setupConnection().catch((err: unknown) => {
        if (!disconnectRequested) {
          emitConnState('fatal', String(err))
        }
      })
    }, delay)
  }

  async function setupConnection(): Promise<void> {
    const prevClient = currentClient
    if (prevClient) {
      currentClient = null
      try {
        await prevClient.disconnect()
      } catch {
        // ignore
      }
    }

    if (disconnectRequested) return

    connectionToken++
    const myToken = connectionToken

    const client = spec.createClient(opts.config)
    currentClient = client

    client.events.on('close', reason => {
      if (myToken !== connectionToken) return
      emitConnState('reconnecting', reason)
      scheduleReconnect()
    })

    client.events.on('error', err => {
      if (myToken !== connectionToken) return
      emitConnState('reconnecting', String(err))
      scheduleReconnect()
    })

    client.events.on('authExpired', () => {
      if (myToken !== connectionToken) return
      emitConnState('reconnecting', 'authExpired')
      scheduleReconnect()
    })

    client.events.on('message', raw => {
      if (myToken !== connectionToken) return
      handleMessage(raw as TRaw)
    })

    await client.connect()

    // disconnectRequested may have flipped during the awaited connect
    if (myToken !== connectionToken || (disconnectRequested as boolean)) return

    retries = 0
    metrics.connectTotal.inc(1, { exchange, status: 'ok' })
    emitConnState('connected')
  }

  function handleMessage(raw: TRaw): void {
    const receivedAt = clock.now()
    const msgSeq = nextSeq()
    const result = spec.parseMessage(raw, receivedAt, msgSeq)

    metrics.messagesTotal.inc(1, { exchange, event: result.eventType })
    if (result.eventTimestampMs !== undefined) {
      metrics.eventLagMs.observe(receivedAt - result.eventTimestampMs, { exchange, event: result.eventType })
    }

    for (const ev of result.orders ?? []) {
      events.emit('order', ev)
      bus.emit('ws.order', ev)
    }
    for (const ev of result.positions ?? []) {
      events.emit('position', ev)
      bus.emit('ws.position', ev)
    }
    for (const ev of result.balances ?? []) {
      events.emit('balance', ev)
      bus.emit('ws.balance', ev)
    }
    for (const ev of result.fills ?? []) {
      events.emit('fill', ev)
      bus.emit('ws.fill', ev)
    }
    for (const ev of result.fundingFees ?? []) {
      events.emit('fundingFee', ev)
      bus.emit('ws.funding_fee', ev)
    }
  }

  return {
    exchange,

    async connect(): Promise<void> {
      if (state !== 'idle') return
      emitConnState('connecting')

      try {
        await setupConnection()
      } catch (err) {
        if (!disconnectRequested) {
          metrics.connectTotal.inc(1, { exchange, status: 'error' })
          emitConnState('fatal', String(err))
        }
        throw err
      }
    },

    async disconnect(): Promise<void> {
      disconnectRequested = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      connectionToken++ // invalidate all pending handlers
      const client = currentClient
      currentClient = null
      if (client) {
        try {
          await client.disconnect()
        } catch {
          // ignore
        }
      }
      emitConnState('disconnected')
      logger.debug({ exchange }, 'privatews.disconnected')
    },

    events,
  }
}

export { makeTypedEmitter }
