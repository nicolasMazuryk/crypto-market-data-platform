import { describe, expect, it, vi } from 'vitest'

import type { Logger } from 'pino'

import type { Clock, RateLimiter } from '../../core/types.js'
import type { ExchangeConfig } from '../../config/types.js'
import type { CcxtExchange, CcxtOrder } from '../../../exchanges/types.js'
import { makeBtcPerp } from '../../test-helpers/ccxtMock.js'
import { MetricsRegistry, registerRestMetrics } from '../../observability/metrics.js'
import { createGateioRestAdapter } from './gateio.js'
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

function makeMockCcxt(overrides: Partial<CcxtExchange> = {}): CcxtExchange & {
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

function makeMockLimiter(): RateLimiter & { acquire: ReturnType<typeof vi.fn> } {
  return {
    acquire: vi.fn().mockResolvedValue(undefined),
    reserve: vi.fn().mockReturnValue(() => {}),
  }
}

function makeMockClock(): Clock {
  return {
    now: vi.fn().mockReturnValue(1000),
    monotonic: vi.fn().mockReturnValue(1000),
    skewMs: vi.fn().mockReturnValue(0),
    recordSkew: vi.fn(),
  }
}

function makeConfig(): ExchangeConfig {
  return {
    exchange: 'gateio',
    enabled: true,
    credentialsEnvPrefix: 'GATEIO',
    rateLimits: { criticalReservationFraction: 0.1, criticalWindowSeconds: 60, buckets: [] },
    marketRefreshMs: 60_000,
    fundingPullMs: 15_000,
  }
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger
}

runRestAdapterConformance({
  exchange: 'gateio',
  makeAdapter: (ccxtOverrides) => {
    const mockCcxt = makeMockCcxt(ccxtOverrides)
    const limiter = makeMockLimiter()
    const registry = new MetricsRegistry()
    const metrics = registerRestMetrics(registry)
    const adapter = createGateioRestAdapter({
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
  duplicateOrderCode: 'TEXT_DUPLICATED',
  sampleSymbol: 'BTCUSDT',
  sampleCcxtSymbol: 'BTC/USDT:USDT',
  clientOrderIdParam: 'text',
})

describe('gateio stop_market params', () => {
  function makeAdapter() {
    const mockCcxt = makeMockCcxt()
    const registry = new MetricsRegistry()
    const metrics = registerRestMetrics(registry)
    const adapter = createGateioRestAdapter({
      config: makeConfig(),
      limiter: makeMockLimiter(),
      clock: makeMockClock(),
      ids: { forIntent: () => 'test', forExit: () => 'test' },
      logger: makeLogger(),
      metrics,
      ccxtFactory: () => mockCcxt,
    })
    return { adapter, ccxt: mockCcxt }
  }

  it('sell-side stop_market maps type to market and sends stopPrice + reduceOnly without text or triggerDirection', async () => {
    const { adapter, ccxt } = makeAdapter()
    await adapter.createOrder({
      intentId: 'i1',
      clientOrderId: 'sl-cid',
      exchange: 'gateio',
      symbol: 'BTCUSDT',
      side: 'sell',
      type: 'stop_market',
      qty: 0.001,
      stopPrice: 44000,
      reduceOnly: true,
    })
    const call = vi.mocked(ccxt.createOrder).mock.calls[0]!
    // type must be 'market' so CCXT sets initial.price = '0' on the price-triggered endpoint
    expect(call[1]).toBe('market')
    expect(call[2]).toBe('sell')
    const params = call[5] as Record<string, unknown>
    expect(params).toHaveProperty('stopPrice', 44000)
    // reduceOnly (camelCase) so CCXT places it inside initial.reduce_only for trigger orders
    expect(params).toHaveProperty('reduceOnly', true)
    expect(params).not.toHaveProperty('reduce_only')
    // text must be absent — CCXT cannot relay it into initial.text and Gate.io rejects top-level unknown fields
    expect(params).not.toHaveProperty('text')
    expect(params).not.toHaveProperty('triggerDirection')
  })

  it('buy-side stop_market maps type to market and sends stopPrice + reduceOnly without text or triggerDirection', async () => {
    const { adapter, ccxt } = makeAdapter()
    await adapter.createOrder({
      intentId: 'i1',
      clientOrderId: 'sl-cid',
      exchange: 'gateio',
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'stop_market',
      qty: 0.001,
      stopPrice: 46000,
      reduceOnly: true,
    })
    const call = vi.mocked(ccxt.createOrder).mock.calls[0]!
    expect(call[1]).toBe('market')
    expect(call[2]).toBe('buy')
    const params = call[5] as Record<string, unknown>
    expect(params).toHaveProperty('stopPrice', 46000)
    expect(params).toHaveProperty('reduceOnly', true)
    expect(params).not.toHaveProperty('reduce_only')
    expect(params).not.toHaveProperty('text')
    expect(params).not.toHaveProperty('triggerDirection')
  })

  it('limit order sends timeInForce key (not tif) so CCXT lowercases it before dispatch', async () => {
    const { adapter, ccxt } = makeAdapter()
    await adapter.createOrder({
      intentId: 'i1',
      clientOrderId: 'tp-cid',
      exchange: 'gateio',
      symbol: 'BTCUSDT',
      side: 'sell',
      type: 'limit',
      qty: 0.001,
      price: 50000,
      timeInForce: 'GTC',
      reduceOnly: true,
    })
    const call = vi.mocked(ccxt.createOrder).mock.calls[0]!
    const params = call[5] as Record<string, unknown>
    // Must use `timeInForce` key so CCXT maps GTC→gtc; raw `tif: 'GTC'` is rejected by Gate.io
    expect(params).toHaveProperty('timeInForce', 'GTC')
    expect(params).not.toHaveProperty('tif')
  })

  it('non-stop order still sends text (client order id)', async () => {
    const { adapter, ccxt } = makeAdapter()
    await adapter.createOrder({
      intentId: 'i1',
      clientOrderId: 'entry-cid',
      exchange: 'gateio',
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'market',
      qty: 0.001,
    })
    const call = vi.mocked(ccxt.createOrder).mock.calls[0]!
    expect(call[1]).toBe('market')
    const params = call[5] as Record<string, unknown>
    expect(params).toHaveProperty('text', 'entry-cid')
  })
})
