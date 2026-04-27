import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Logger } from 'pino'

import type { Clock, RateLimiter } from '../../core/types.js'
import type { ExchangeConfig } from '../../config/types.js'
import type { CcxtExchange, CcxtOrder, CcxtPosition } from '../../../exchanges/types.js'
import { makeBtcPerp } from '../../test-helpers/ccxtMock.js'
import { MetricsRegistry, registerRestMetrics } from '../../observability/metrics.js'
import { createBinanceRestAdapter } from './binance.js'
import type { OrderRequest } from './types.js'
import { runRestAdapterConformance } from './__tests__/conformance.js'

function makeOrderRaw(overrides: Partial<CcxtOrder> = {}): CcxtOrder {
  return {
    id: 'ex-123',
    clientOrderId: 'test-cid',
    symbol: 'BTC/USDT:USDT',
    side: 'buy',
    type: 'market',
    amount: 0.001,
    filled: 0,
    status: 'open',
    timestamp: 1000,
    info: {},
    ...overrides,
  }
}

function makePositionRaw(overrides: Partial<CcxtPosition> = {}): CcxtPosition {
  return {
    symbol: 'BTC/USDT:USDT',
    side: 'long',
    contracts: 2,
    entryPrice: 50000,
    markPrice: 51000,
    leverage: 4,
    unrealizedPnl: 2000,
    liquidationPrice: 40000,
    timestamp: 1000,
    info: {},
    ...overrides,
  }
}

export function makeMockCcxt(overrides: Partial<CcxtExchange> = {}): CcxtExchange & {
  createOrder: ReturnType<typeof vi.fn>
  cancelOrder: ReturnType<typeof vi.fn>
  editOrder: ReturnType<typeof vi.fn>
  fetchOrder: ReturnType<typeof vi.fn>
  fetchOpenOrders: ReturnType<typeof vi.fn>
  fetchPositions: ReturnType<typeof vi.fn>
  fetchBalance: ReturnType<typeof vi.fn>
  setLeverage: ReturnType<typeof vi.fn>
  fetchTime: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  const btcMarket = makeBtcPerp()
  return {
    loadMarkets: vi.fn().mockResolvedValue({ 'BTC/USDT:USDT': btcMarket }),
    market: vi.fn().mockReturnValue(btcMarket),
    markets: { 'BTC/USDT:USDT': btcMarket },
    createOrder: vi.fn().mockResolvedValue(makeOrderRaw()),
    cancelOrder: vi.fn().mockResolvedValue({}),
    editOrder: vi.fn().mockResolvedValue(makeOrderRaw({ type: 'limit', price: 45000 })),
    fetchOrder: vi.fn().mockResolvedValue(null),
    fetchOpenOrders: vi.fn().mockResolvedValue([]),
    fetchPositions: vi.fn().mockResolvedValue([]),
    fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 1000 }, used: { USDT: 50 } }),
    setLeverage: vi.fn().mockResolvedValue({}),
    fetchTime: vi.fn().mockResolvedValue(2000),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as ReturnType<typeof makeMockCcxt>
}

export function makeMockLimiter(): RateLimiter & { acquire: ReturnType<typeof vi.fn> } {
  return {
    acquire: vi.fn().mockResolvedValue(undefined),
    reserve: vi.fn().mockReturnValue(() => {}),
  }
}

export function makeMockClock(): Clock {
  return {
    now: vi.fn().mockReturnValue(1000),
    monotonic: vi.fn().mockReturnValue(1000),
    skewMs: vi.fn().mockReturnValue(0),
    recordSkew: vi.fn(),
  }
}

export function makeConfig(): ExchangeConfig {
  return {
    exchange: 'binance',
    enabled: true,
    credentialsEnvPrefix: 'BINANCE',
    rateLimits: { criticalReservationFraction: 0.1, criticalWindowSeconds: 60, buckets: [] },
    marketRefreshMs: 60_000,
    fundingPullMs: 15_000,
  }
}

export function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger
}

export function makeAdapter(ccxtOverrides?: Partial<CcxtExchange>) {
  const mockCcxt = makeMockCcxt(ccxtOverrides)
  const limiter = makeMockLimiter()
  const clock = makeMockClock()
  const registry = new MetricsRegistry()
  const metrics = registerRestMetrics(registry)

  const adapter = createBinanceRestAdapter({
    config: makeConfig(),
    limiter,
    clock,
    ids: { forIntent: () => 'test', forExit: () => 'test' },
    logger: makeLogger(),
    metrics,
    ccxtFactory: () => mockCcxt,
  })

  return { adapter, mockCcxt, limiter, clock, registry }
}

const defaultOrderReq: OrderRequest = {
  intentId: 'intent-1',
  clientOrderId: 'test-cid',
  exchange: 'binance',
  symbol: 'BTCUSDT',
  side: 'buy',
  type: 'market',
  qty: 0.001,
}

// ─── Conformance suite ──────────────────────────────────────────────────────

runRestAdapterConformance({
  exchange: 'binance',
  makeAdapter: (ccxtOverrides) => {
    const mockCcxt = makeMockCcxt(ccxtOverrides)
    const limiter = makeMockLimiter()
    const registry = new MetricsRegistry()
    const metrics = registerRestMetrics(registry)
    const adapter = createBinanceRestAdapter({
      config: makeConfig(),
      limiter,
      clock: makeMockClock(),
      ids: { forIntent: () => 'test', forExit: () => 'test' },
      logger: makeLogger(),
      metrics,
      ccxtFactory: () => mockCcxt,
    })
    return { adapter, ccxt: mockCcxt, limiter }
  },
  duplicateOrderCode: '-4116',
  sampleSymbol: 'BTCUSDT',
  sampleCcxtSymbol: 'BTC/USDT:USDT',
  clientOrderIdParam: 'newClientOrderId',
})

// ─── Binance-specific tests ──────────────────────────────────────────────────

describe('BinanceRestAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('createOrder happy path: returns accepted ack with exchangeOrderId', async () => {
    const { adapter, limiter } = makeAdapter()

    const ack = await adapter.createOrder(defaultOrderReq)

    expect(ack.status).toBe('accepted')
    expect(ack.exchangeOrderId).toBe('ex-123')
    expect(ack.clientOrderId).toBe('test-cid')
    expect(limiter.acquire).toHaveBeenCalledWith('order_write', expect.objectContaining({ priority: 'critical' }))
  })

  it('createOrder passes newClientOrderId in params', async () => {
    const { adapter, mockCcxt } = makeAdapter()

    await adapter.createOrder(defaultOrderReq)

    expect(mockCcxt.createOrder).toHaveBeenCalledWith(
      'BTC/USDT:USDT',
      'market',
      'buy',
      0.001,
      undefined,
      expect.objectContaining({ newClientOrderId: 'test-cid' })
    )
  })

  it('createOrder with exchange rejection returns OrderAck { status: rejected }', async () => {
    const invalidOrderErr = new Error('binanceusdm -2019 Margin is insufficient')
    invalidOrderErr.name = 'InvalidOrder'

    const { adapter } = makeAdapter({ createOrder: vi.fn().mockRejectedValue(invalidOrderErr) })

    const ack = await adapter.createOrder(defaultOrderReq)

    expect(ack.status).toBe('rejected')
    expect(ack.rejectReason).toMatch('-2019')
  })

  it('createOrder network error → fetchOrder finds existing → idempotency hit', async () => {
    const networkErr = new Error('network timeout')
    networkErr.name = 'NetworkError'

    const existingOrder = makeOrderRaw()
    const mockCcxt = makeMockCcxt({
      createOrder: vi.fn().mockRejectedValue(networkErr),
      fetchOrder: vi.fn().mockResolvedValue(existingOrder),
    })

    const registry = new MetricsRegistry()
    const metrics = registerRestMetrics(registry)
    const adapter = createBinanceRestAdapter({
      config: makeConfig(),
      limiter: makeMockLimiter(),
      clock: makeMockClock(),
      ids: { forIntent: () => 'test', forExit: () => 'test' },
      logger: makeLogger(),
      metrics,
      ccxtFactory: () => mockCcxt,
    })

    const ackPromise = adapter.createOrder(defaultOrderReq)
    // Allow sleepWithJitter to execute
    await vi.runAllTimersAsync()
    const ack = await ackPromise

    expect(ack.status).toBe('accepted')
    expect(ack.exchangeOrderId).toBe('ex-123')

    const rendered = await registry.render()
    expect(rendered).toMatch(/rest_idempotency_hits_total\{exchange="binance"\} 1/)
  })

  it('createOrder network error → fetchOrder null → one retry succeeds', async () => {
    const networkErr = new Error('network timeout')
    networkErr.name = 'NetworkError'

    let createCallCount = 0
    const mockCcxt = makeMockCcxt({
      createOrder: vi.fn().mockImplementation(() => {
        createCallCount++
        if (createCallCount === 1) return Promise.reject(networkErr)
        return Promise.resolve(makeOrderRaw())
      }),
      fetchOrder: vi.fn().mockResolvedValue(null),
    })

    const adapter = createBinanceRestAdapter({
      config: makeConfig(),
      limiter: makeMockLimiter(),
      clock: makeMockClock(),
      ids: { forIntent: () => 'test', forExit: () => 'test' },
      logger: makeLogger(),
      metrics: registerRestMetrics(new MetricsRegistry()),
      ccxtFactory: () => mockCcxt,
    })

    const ackPromise = adapter.createOrder(defaultOrderReq)
    await vi.runAllTimersAsync()
    const ack = await ackPromise

    expect(ack.status).toBe('accepted')
    expect(createCallCount).toBe(2)
  })

  it('createOrder two consecutive network errors throws', async () => {
    const networkErr = new Error('network timeout')
    networkErr.name = 'NetworkError'

    const mockCcxt = makeMockCcxt({
      createOrder: vi.fn().mockRejectedValue(networkErr),
      fetchOrder: vi.fn().mockResolvedValue(null),
    })

    const adapter = createBinanceRestAdapter({
      config: makeConfig(),
      limiter: makeMockLimiter(),
      clock: makeMockClock(),
      ids: { forIntent: () => 'test', forExit: () => 'test' },
      logger: makeLogger(),
      metrics: registerRestMetrics(new MetricsRegistry()),
      ccxtFactory: () => mockCcxt,
    })

    const ackPromise = adapter.createOrder(defaultOrderReq)
    // Attach rejection handler before advancing timers to avoid unhandled rejection warning
    const expectRejects = expect(ackPromise).rejects.toThrow()
    await vi.runAllTimersAsync()
    await expectRejects
  })

  it('cancelOrder with OrderNotFound resolves without throw', async () => {
    const notFoundErr = new Error('order not found')
    notFoundErr.name = 'OrderNotFound'

    const { adapter } = makeAdapter({ cancelOrder: vi.fn().mockRejectedValue(notFoundErr) })

    await expect(adapter.cancelOrder({ symbol: 'BTCUSDT', clientOrderId: 'test-cid' })).resolves.not.toThrow()
  })

  it('setLeverage called once for repeated createOrders with same leverage', async () => {
    const { adapter, mockCcxt } = makeAdapter()

    await adapter.createOrder({ ...defaultOrderReq, leverage: 4 })
    await adapter.createOrder({ ...defaultOrderReq, leverage: 4 })

    expect(mockCcxt.setLeverage).toHaveBeenCalledTimes(1)
  })

  it('setLeverage called again when leverage changes', async () => {
    const { adapter, mockCcxt } = makeAdapter()

    await adapter.createOrder({ ...defaultOrderReq, leverage: 4 })
    await adapter.createOrder({ ...defaultOrderReq, leverage: 10 })

    expect(mockCcxt.setLeverage).toHaveBeenCalledTimes(2)
  })

  it('setLeverage: -4046 code means already set, treats as success', async () => {
    const alreadySetErr = new Error('binanceusdm -4046 No need to change margin type')
    alreadySetErr.name = 'ExchangeError'
    const { adapter } = makeAdapter({ setLeverage: vi.fn().mockRejectedValue(alreadySetErr) })
    await expect(adapter.setLeverage('BTCUSDT', 4)).resolves.not.toThrow()
  })

  it('each method consults the rate limiter', async () => {
    const { adapter, limiter } = makeAdapter()

    await adapter.createOrder(defaultOrderReq)
    await adapter.cancelOrder({ symbol: 'BTCUSDT' })
    await adapter.getOpenOrders('BTCUSDT')
    await adapter.getPositions()
    await adapter.getBalance()
    await adapter.getServerTime()

    const classes = limiter.acquire.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(classes).toContain('order_write')
    expect(classes).toContain('order_read')
    expect(classes).toContain('account_read')
    expect(classes).toContain('time')
  })

  it('getServerTime records clock skew', async () => {
    const { adapter, clock } = makeAdapter()

    const t = await adapter.getServerTime()

    expect(t).toBe(2000)
    expect(clock.recordSkew).toHaveBeenCalledWith('binance', 2000, expect.any(Number))
  })

  it('getPositions filters out zero-qty positions', async () => {
    const { adapter } = makeAdapter({
      fetchPositions: vi.fn().mockResolvedValue([makePositionRaw({ contracts: 0 }), makePositionRaw({ contracts: 2 })]),
    })

    const positions = await adapter.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0]?.qty).toBe(2)
  })

  it('getPositions maps side correctly', async () => {
    const { adapter } = makeAdapter({
      fetchPositions: vi
        .fn()
        .mockResolvedValue([
          makePositionRaw({ side: 'long', contracts: 1 }),
          makePositionRaw({ side: 'short', contracts: -1, symbol: 'ETH/USDT:USDT' }),
        ]),
    })

    const positions = await adapter.getPositions()
    expect(positions[0]?.side).toBe('long')
    expect(positions[1]?.side).toBe('short')
  })

  it('symbol normalization: receives BTCUSDT, calls CCXT with BTC/USDT:USDT', async () => {
    const { adapter, mockCcxt } = makeAdapter()

    await adapter.createOrder(defaultOrderReq) // symbol: 'BTCUSDT'

    expect(mockCcxt.createOrder).toHaveBeenCalledWith(
      'BTC/USDT:USDT',
      expect.any(String),
      expect.any(String),
      expect.any(Number),
      undefined,
      expect.any(Object)
    )
  })

  it('amendOrder passes origClientOrderId and returns new ack', async () => {
    const { adapter, mockCcxt } = makeAdapter()

    const ack = await adapter.amendOrder({ symbol: 'BTCUSDT', clientOrderId: 'test-cid' }, { price: 45000 })

    expect(ack.status).toBe('accepted')
    expect(mockCcxt.editOrder).toHaveBeenCalledWith(
      '',
      'BTC/USDT:USDT',
      '',
      '',
      undefined,
      45000,
      expect.objectContaining({ origClientOrderId: 'test-cid' })
    )
  })

  it('getBalance returns USDT balance', async () => {
    const { adapter } = makeAdapter()

    const balances = await adapter.getBalance()

    expect(balances).toHaveLength(1)
    expect(balances[0]?.asset).toBe('USDT')
    expect(balances[0]?.available).toBe(1000)
    expect(balances[0]?.locked).toBe(50)
  })
})

describe('binance stop_market params', () => {
  it('sell-side stop_market sends stopPrice and side without triggerDirection', async () => {
    const { adapter, mockCcxt } = makeAdapter()
    await adapter.createOrder({
      intentId: 'i1',
      clientOrderId: 'sl-cid',
      exchange: 'binance',
      symbol: 'BTCUSDT',
      side: 'sell',
      type: 'stop_market',
      qty: 0.001,
      stopPrice: 44000,
      reduceOnly: true,
    })
    const call = vi.mocked(mockCcxt.createOrder).mock.calls[0]!
    expect(call[2]).toBe('sell')
    const params = call[5] as Record<string, unknown>
    expect(params).toHaveProperty('stopPrice', 44000)
    expect(params).not.toHaveProperty('triggerDirection')
  })

  it('buy-side stop_market sends stopPrice and side without triggerDirection', async () => {
    const { adapter, mockCcxt } = makeAdapter()
    await adapter.createOrder({
      intentId: 'i1',
      clientOrderId: 'sl-cid',
      exchange: 'binance',
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'stop_market',
      qty: 0.001,
      stopPrice: 46000,
      reduceOnly: true,
    })
    const call = vi.mocked(mockCcxt.createOrder).mock.calls[0]!
    expect(call[2]).toBe('buy')
    const params = call[5] as Record<string, unknown>
    expect(params).toHaveProperty('stopPrice', 46000)
    expect(params).not.toHaveProperty('triggerDirection')
  })
})
