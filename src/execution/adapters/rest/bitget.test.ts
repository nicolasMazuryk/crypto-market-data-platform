import { describe, expect, it, vi } from 'vitest'

import type { Logger } from 'pino'

import type { Clock, RateLimiter } from '../../core/types.js'
import type { ExchangeConfig } from '../../config/types.js'
import type { CcxtExchange, CcxtOrder } from '../../../exchanges/types.js'
import { makeBtcPerp } from '../../test-helpers/ccxtMock.js'
import { MetricsRegistry, registerRestMetrics } from '../../observability/metrics.js'
import { createBitgetRestAdapter } from './bitget.js'
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
    exchange: 'bitget',
    enabled: true,
    credentialsEnvPrefix: 'BITGET',
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
  exchange: 'bitget',
  makeAdapter: ccxtOverrides => {
    const mockCcxt = makeMockCcxt(ccxtOverrides)
    const limiter = makeMockLimiter()
    const registry = new MetricsRegistry()
    const metrics = registerRestMetrics(registry)
    const adapter = createBitgetRestAdapter({
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
  duplicateOrderCode: '40762',
  sampleSymbol: 'BTCUSDT',
  sampleCcxtSymbol: 'BTC/USDT:USDT',
  clientOrderIdParam: 'clientOid',
})

describe('bitget stop_market params', () => {
  function makeAdapter() {
    const mockCcxt = makeMockCcxt()
    const registry = new MetricsRegistry()
    const metrics = registerRestMetrics(registry)
    const adapter = createBitgetRestAdapter({
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

  it('sell-side stop_market sends stopPrice and side without triggerDirection', async () => {
    const { adapter, ccxt } = makeAdapter()
    await adapter.createOrder({
      intentId: 'i1',
      clientOrderId: 'sl-cid',
      exchange: 'bitget',
      symbol: 'BTCUSDT',
      side: 'sell',
      type: 'stop_market',
      qty: 0.001,
      stopPrice: 44000,
      reduceOnly: true,
    })
    const call = vi.mocked(ccxt.createOrder).mock.calls[0]!
    expect(call[2]).toBe('sell')
    const params = call[5] as Record<string, unknown>
    expect(params).toHaveProperty('stopPrice', 44000)
    expect(params).not.toHaveProperty('triggerDirection')
  })

  it('buy-side stop_market sends stopPrice and side without triggerDirection', async () => {
    const { adapter, ccxt } = makeAdapter()
    await adapter.createOrder({
      intentId: 'i1',
      clientOrderId: 'sl-cid',
      exchange: 'bitget',
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'stop_market',
      qty: 0.001,
      stopPrice: 46000,
      reduceOnly: true,
    })
    const call = vi.mocked(ccxt.createOrder).mock.calls[0]!
    expect(call[2]).toBe('buy')
    const params = call[5] as Record<string, unknown>
    expect(params).toHaveProperty('stopPrice', 46000)
    expect(params).not.toHaveProperty('triggerDirection')
  })
})
