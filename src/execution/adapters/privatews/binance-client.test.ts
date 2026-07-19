import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBinanceWsClient } from './binance-client.js'

// ─── HTTP mock ────────────────────────────────────────────────────────────────
const httpRequestSpy = vi.fn()

vi.mock('node:https', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  request: (...args: unknown[]) => httpRequestSpy(...args),
}))
vi.mock('node:http', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  request: (...args: unknown[]) => httpRequestSpy(...args),
}))

// ─── WebSocket mock ───────────────────────────────────────────────────────────
// Must use vi.hoisted so MockWS is defined before vi.mock factories run

type AnyHandler = (...args: unknown[]) => void
interface FakeWs {
  url: string
  _trigger(event: string, ...args: unknown[]): void
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  removeAllListeners: ReturnType<typeof vi.fn>
}

const { MockWS, wsInstances } = vi.hoisted(() => {
  const wsInstances: FakeWs[] = []
  const MockWS = vi.fn().mockImplementation((url: string): FakeWs => {
    const handlers: Record<string, AnyHandler[]> = {}
    const inst: FakeWs = {
      url,
      _trigger(event: string, ...args: unknown[]) {
        for (const h of [...(handlers[event] ?? [])]) h(...args)
      },
      on: vi.fn((event: string, cb: AnyHandler) => {
        ;(handlers[event] ??= []).push(cb)
      }),
      once: vi.fn((event: string, cb: AnyHandler) => {
        const wrapped: AnyHandler = (...args) => {
          handlers[event] = (handlers[event] ?? []).filter(h => h !== wrapped)
          cb(...args)
        }
        ;(handlers[event] ??= []).push(wrapped)
      }),
      close: vi.fn(),
      removeAllListeners: vi.fn(() => {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        for (const k in handlers) delete handlers[k]
      }),
    }
    wsInstances.push(inst)
    process.nextTick(() => {
      inst._trigger('open')
    })
    return inst
  })
  return { MockWS, wsInstances }
})

vi.mock('ws', () => ({ default: MockWS }))

// ─── HTTP mock helpers ────────────────────────────────────────────────────────
let listenKeySeq = 0

function makeListenKeyBody(): string {
  return JSON.stringify({ listenKey: `lk-${String(++listenKeySeq)}` })
}

function setupHttpMock(): void {
  httpRequestSpy.mockImplementation((opts: { method?: string }, callback?: (res: EventEmitter) => void) => {
    const method = (opts.method ?? 'POST').toUpperCase()
    const res = new EventEmitter()
    const req = Object.assign(new EventEmitter(), {
      end: vi.fn(() => {
        const body = method === 'POST' ? makeListenKeyBody() : '{}'
        if (callback) {
          callback(res)
          res.emit('data', body)
          res.emit('end')
        }
      }),
    })
    return req
  })
}

const REST_BASE = 'http://test.local'
const WS_BASE = 'ws://test.local'

function makeClient() {
  return createBinanceWsClient({
    credentials: { apiKey: 'test-key', apiSecret: 'test-secret' },
    restBaseUrl: REST_BASE,
    wsBaseUrl: WS_BASE,
  })
}

describe('createBinanceWsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wsInstances.length = 0
    listenKeySeq = 0
    setupHttpMock()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('connect() creates a listenKey and opens WebSocket to the correct URL', async () => {
    const client = makeClient()
    await client.connect()

    const postCalls = httpRequestSpy.mock.calls.filter(c => (c[0] as { method: string }).method === 'POST')
    expect(postCalls).toHaveLength(1)
    expect((postCalls[0]?.[0] as { path: string }).path).toBe('/fapi/v1/listenKey')
    expect(wsInstances).toHaveLength(1)
    expect(wsInstances[0]?.url).toBe(`${WS_BASE}/ws/lk-1`)

    await client.disconnect()
  })

  it('ORDER_TRADE_UPDATE messages are forwarded via events.on("message")', async () => {
    const client = makeClient()
    await client.connect()

    const received: unknown[] = []
    client.events.on('message', msg => received.push(msg))

    const payload = { e: 'ORDER_TRADE_UPDATE', E: 1_000_000, o: { s: 'BTCUSDT' } }
    wsInstances[0]!._trigger('message', Buffer.from(JSON.stringify(payload)))

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ e: 'ORDER_TRADE_UPDATE' })

    await client.disconnect()
  })

  it('listenKeyExpired event triggers immediate key rotation', async () => {
    const client = makeClient()
    await client.connect()

    const expiredEvents: true[] = []
    client.events.on('listenKeyExpired', () => expiredEvents.push(true))

    httpRequestSpy.mockClear()

    wsInstances[0]!._trigger('message', Buffer.from(JSON.stringify({ e: 'listenKeyExpired', E: 0 })))

    // Drain event loop so rotation (createListenKey + openSocket) completes
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    expect(expiredEvents).toHaveLength(1)
    const postCalls = httpRequestSpy.mock.calls.filter(c => (c[0] as { method: string }).method === 'POST')
    expect(postCalls.length).toBeGreaterThanOrEqual(1)
    expect(wsInstances.length).toBeGreaterThanOrEqual(2)

    await client.disconnect()
  })

  it('keepalive PUT fires after 30-min interval', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    await client.connect()

    httpRequestSpy.mockClear()

    await vi.advanceTimersByTimeAsync(30 * 60 * 1_000)

    const putCalls = httpRequestSpy.mock.calls.filter(c => (c[0] as { method: string }).method === 'PUT')
    expect(putCalls).toHaveLength(1)
    expect((putCalls[0]?.[0] as { path: string }).path).toContain('listenKey=lk-1')

    await client.disconnect()
  })

  it('rotation fires at 50-min interval: new listenKey created, new WS opened, old WS closed', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    await client.connect()

    const firstSocket = wsInstances[0]!
    httpRequestSpy.mockClear()

    // Trigger the rotation setInterval
    await vi.advanceTimersByTimeAsync(50 * 60 * 1_000)
    // Complete the 30s overlap setTimeout inside rotateKey()
    await vi.advanceTimersByTimeAsync(30 * 1_000)

    const postCalls = httpRequestSpy.mock.calls.filter(c => (c[0] as { method: string }).method === 'POST')
    expect(postCalls.length).toBeGreaterThanOrEqual(1)
    expect(wsInstances.length).toBeGreaterThanOrEqual(2)
    expect(firstSocket.close).toHaveBeenCalled()

    await client.disconnect()
  })

  it('no timers fire after disconnect()', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    await client.connect()

    await client.disconnect()
    httpRequestSpy.mockClear()

    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000)

    const activeCalls = httpRequestSpy.mock.calls.filter(c =>
      ['PUT', 'POST'].includes((c[0] as { method: string }).method)
    )
    expect(activeCalls).toHaveLength(0)
  })
})
