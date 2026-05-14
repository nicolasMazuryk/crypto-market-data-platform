import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createEventBus } from '../../core/bus.js'
import { createClock } from '../../core/clock.js'
import { createExecutionLogger } from '../../core/logger.js'
import { MetricsRegistry, registerPrivateWsMetrics } from '../../observability/metrics.js'
import { createFakeBinanceWsClient } from '../../test-helpers/wsClientMock.js'
import { createBinancePrivateWsAdapter } from './binance.js'
import type { ConnectionStateEvent, OrderEvent, BalanceEvent, PositionEvent, FundingFeeEvent } from './types.js'
import type { ExchangeConfig } from '../../config/types.js'
import { createFakeWsClient, runWsAdapterConformance } from './__tests__/conformance.js'
import { createPrivateWsAdapterFromSpec } from './private-ws-base.js'
import type { PrivateWsClient } from './private-ws-base.js'
import { mapAccountUpdate, mapFundingFee, mapOrderTradeUpdate } from './mapping.js'
import type { BinanceAccountUpdateRaw, BinanceOrderUpdateRaw } from './mapping.js'

function makeConfig(): ExchangeConfig {
  return {
    exchange: 'binance',
    enabled: true,
    credentialsEnvPrefix: 'BINANCE',
    rateLimits: { criticalReservationFraction: 0.1, criticalWindowSeconds: 1, buckets: [] },
    marketRefreshMs: 60000,
    fundingPullMs: 60000,
  }
}

describe('createBinancePrivateWsAdapter', () => {
  let fakeClient: ReturnType<typeof createFakeBinanceWsClient>
  let adapter: ReturnType<typeof createBinancePrivateWsAdapter>
  const bus = createEventBus()
  const clock = createClock()
  const logger = createExecutionLogger()
  const registry = new MetricsRegistry()
  const metrics = registerPrivateWsMetrics(registry)

  beforeEach(() => {
    vi.useFakeTimers()
    fakeClient = createFakeBinanceWsClient()
    adapter = createBinancePrivateWsAdapter({
      config: makeConfig(),
      bus,
      clock,
      logger,
      metrics,
      wsClientFactory: () => fakeClient,
    })
  })

  afterEach(async () => {
    await adapter.disconnect().catch(() => undefined)
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // Test 1: ORDER_TRADE_UPDATE → order event + bus ws.order
  it('parses ORDER_TRADE_UPDATE and emits order event', async () => {
    const orderEvents: OrderEvent[] = []
    adapter.events.on('order', e => orderEvents.push(e))
    const busOrders: OrderEvent[] = []
    bus.on('ws.order', e => busOrders.push(e))

    await adapter.connect()

    fakeClient.emit.message({
      e: 'ORDER_TRADE_UPDATE',
      E: 1700000000000,
      T: 1700000000000,
      o: {
        s: 'BTCUSDT',
        c: 'cid-1',
        S: 'BUY',
        o: 'LIMIT',
        q: '0.001',
        p: '30000',
        ap: '0',
        sp: '0',
        X: 'NEW',
        i: 12345,
        z: '0',
        R: false,
        T: '1700000000000',
      },
    })

    expect(orderEvents).toHaveLength(1)
    expect(orderEvents[0]!.order.status).toBe('new')
    expect(orderEvents[0]!.order.symbol).toBe('BTCUSDT')
    expect(busOrders).toHaveLength(1)
    expect(busOrders[0]!.order.clientOrderId).toBe('cid-1')
  })

  it('maps NEW→new and FILLED→filled order status', async () => {
    const orders: OrderEvent[] = []
    adapter.events.on('order', e => orders.push(e))
    await adapter.connect()

    fakeClient.emit.message({
      e: 'ORDER_TRADE_UPDATE',
      E: 1,
      T: 1,
      o: {
        s: 'BTCUSDT',
        c: 'cid',
        S: 'BUY',
        o: 'MARKET',
        q: '1',
        p: '0',
        ap: '0',
        sp: '0',
        X: 'FILLED',
        i: 1,
        z: '1',
        R: false,
        T: '1',
      },
    })
    expect(orders[0]!.order.status).toBe('filled')
  })

  // Test 2: ACCOUNT_UPDATE → balance + position events
  it('parses ACCOUNT_UPDATE and emits balance + position events', async () => {
    const balances: BalanceEvent[] = []
    const positions: PositionEvent[] = []
    adapter.events.on('balance', e => balances.push(e))
    adapter.events.on('position', e => positions.push(e))
    await adapter.connect()

    fakeClient.emit.message({
      e: 'ACCOUNT_UPDATE',
      E: 1700000001000,
      T: 1700000001000,
      a: {
        m: 'ORDER',
        B: [{ a: 'USDT', wb: '10000', cw: '9500', bc: '0' }],
        P: [{ s: 'BTCUSDT', pa: '0.01', ep: '30000', up: '10', ps: 'BOTH' }],
      },
    })

    expect(balances).toHaveLength(1)
    expect(balances[0]!.balance.asset).toBe('USDT')
    expect(positions).toHaveLength(1)
    expect(positions[0]!.position.symbol).toBe('BTCUSDT')
  })

  // Test 3: FUNDING_FEE → fundingFee event
  it('parses ACCOUNT_UPDATE with m=FUNDING_FEE and emits fundingFee event', async () => {
    const fees: FundingFeeEvent[] = []
    adapter.events.on('fundingFee', e => fees.push(e))
    await adapter.connect()

    fakeClient.emit.message({
      e: 'ACCOUNT_UPDATE',
      E: 1700000002000,
      T: 1700000002000,
      a: {
        m: 'FUNDING_FEE',
        B: [{ a: 'USDT', wb: '9995', cw: '9495', bc: '-4.5' }],
        P: [{ s: 'ETHUSDT', pa: '10', ep: '2000', up: '0', ps: 'BOTH' }],
      },
    })

    expect(fees).toHaveLength(1)
    expect(fees[0]!.symbol).toBe('ETHUSDT')
    expect(fees[0]!.fundingAmount).toBe(-4.5)
  })

  // Test 4: Sequence numbers never reset
  it('assigns monotonically increasing seq numbers that never reset on reconnect', async () => {
    const seqs: number[] = []
    adapter.events.on('order', e => seqs.push(e.seq))
    await adapter.connect()

    const makeMsg = () => ({
      e: 'ORDER_TRADE_UPDATE',
      E: 1,
      T: 1,
      o: {
        s: 'BTCUSDT',
        c: 'cid',
        S: 'BUY',
        o: 'MARKET',
        q: '1',
        p: '0',
        ap: '0',
        sp: '0',
        X: 'NEW',
        i: 1,
        z: '0',
        R: false,
        T: '1',
      },
    })

    for (let i = 0; i < 5; i++) fakeClient.emit.message(makeMsg())
    expect(seqs).toEqual([1, 2, 3, 4, 5])

    // Simulate reconnect
    fakeClient.emit.close('network drop')
    await vi.runAllTimersAsync()

    for (let i = 0; i < 2; i++) fakeClient.emit.message(makeMsg())
    expect(seqs[5]).toBe(6)
    expect(seqs[6]).toBe(7)
  })

  // Test 5: Connection state transitions
  it('transitions through connecting → connected → reconnecting → connected → disconnected', async () => {
    const states: string[] = []
    adapter.events.on('connectionState', e => states.push(e.state))

    await adapter.connect()
    fakeClient.emit.close('network drop')
    await vi.runAllTimersAsync()
    await adapter.disconnect()

    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connected', 'disconnected'])
  })

  it('increments reconnectTotal metric on reconnect', async () => {
    await adapter.connect()
    fakeClient.emit.close('drop')
    await vi.runAllTimersAsync()

    const metricsBody = await registry.render()
    expect(metricsBody).toMatch(/ws_reconnect_total\{exchange="binance"\}/)
  })

  // Test 6: Lag histogram
  it('observes event lag as receivedAt - E', async () => {
    vi.spyOn(clock, 'now').mockReturnValue(2150)
    await adapter.connect()

    fakeClient.emit.message({
      e: 'ORDER_TRADE_UPDATE',
      E: 1000,
      T: 1000,
      o: {
        s: 'BTCUSDT',
        c: 'cid',
        S: 'BUY',
        o: 'MARKET',
        q: '1',
        p: '0',
        ap: '0',
        sp: '0',
        X: 'NEW',
        i: 1,
        z: '0',
        R: false,
        T: '1000',
      },
    })

    const body = await registry.render()
    expect(body).toMatch(/ws_event_lag_ms/)
  })

  // Test 7: listenKey/connect rejection → fatal
  it('goes to fatal state when connect() rejects', async () => {
    const authError = new Error('401 Unauthorized')
    vi.mocked(fakeClient.connect).mockRejectedValueOnce(authError)

    const states: ConnectionStateEvent[] = []
    adapter.events.on('connectionState', e => states.push(e))

    await expect(adapter.connect()).rejects.toThrow('401')

    const fatal = states.find(s => s.state === 'fatal')
    expect(fatal).toBeDefined()

    const body = await registry.render()
    expect(body).toMatch(/ws_connection_state\{exchange="binance"\} 4/)
  })
})

// ─── WS Conformance suite ──────────────────────────────────────────────────

const sampleOrderRaw = {
  e: 'ORDER_TRADE_UPDATE',
  E: 1700000000000,
  T: 1700000000000,
  o: {
    s: 'BTCUSDT',
    c: 'cid-1',
    S: 'BUY',
    o: 'LIMIT',
    q: '0.001',
    p: '30000',
    ap: '0',
    sp: '0',
    X: 'NEW',
    i: 12345,
    z: '0',
    R: false,
    T: '1700000000000',
  },
}

// ACCOUNT_UPDATE emits both balance + position events — works for both samplePositionRaw and sampleBalanceRaw
const sampleAccountRaw = {
  e: 'ACCOUNT_UPDATE',
  E: 1000,
  T: 1000,
  a: {
    m: 'ORDER',
    B: [{ a: 'USDT', wb: '10000', cw: '9500', bc: '0' }],
    P: [{ s: 'BTCUSDT', pa: '0.01', ep: '30000', up: '10', ps: 'BOTH' }],
  },
}

const conformanceBus = createEventBus()
const conformanceClock = createClock()
const conformanceLogger = createExecutionLogger()
const conformanceRegistry = new MetricsRegistry()
const conformanceMetrics = registerPrivateWsMetrics(conformanceRegistry)

interface BinanceRaw {
  e: string
  E: number
  [key: string]: unknown
}

function parseBinanceRaw(raw: unknown, receivedAt: number, seq: number) {
  const r = raw as BinanceRaw
  if (r.e === 'ORDER_TRADE_UPDATE') {
    const orderEv = mapOrderTradeUpdate(raw as BinanceOrderUpdateRaw, receivedAt, seq)
    return { orders: [orderEv], eventType: r.e, eventTimestampMs: r.E }
  }
  if (r.e === 'ACCOUNT_UPDATE') {
    const acctRaw = raw as BinanceAccountUpdateRaw
    const { balances, positions } = mapAccountUpdate(acctRaw, receivedAt, seq)
    const fee = mapFundingFee(acctRaw, receivedAt, seq)
    return { balances, positions, fundingFees: fee ? [fee] : undefined, eventType: r.e, eventTimestampMs: r.E }
  }
  return { eventType: r.e, eventTimestampMs: r.E }
}

runWsAdapterConformance({
  exchange: 'binance',
  createAdapter: clientFactory => {
    const fakeWs: PrivateWsClient = clientFactory ? clientFactory() : createFakeWsClient()
    return createPrivateWsAdapterFromSpec(
      { exchange: 'binance', createClient: () => fakeWs, parseMessage: parseBinanceRaw },
      {
        config: makeConfig(),
        bus: conformanceBus,
        clock: conformanceClock,
        logger: conformanceLogger,
        metrics: conformanceMetrics,
      }
    )
  },
  sampleOrderRaw,
  samplePositionRaw: sampleAccountRaw,
  sampleBalanceRaw: sampleAccountRaw,
  sampleFundingFeeRaw: {
    e: 'ACCOUNT_UPDATE',
    E: 1700000002000,
    T: 1700000002000,
    a: {
      m: 'FUNDING_FEE',
      B: [{ a: 'USDT', wb: '9995.5', cw: '9495.5', bc: '-4.5' }],
      P: [{ s: 'BTCUSDT', pa: '0.01', ep: '30000', up: '0', ps: 'BOTH' }],
    },
  },
})
