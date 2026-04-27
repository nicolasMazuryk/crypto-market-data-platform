import { describe, expect, it, vi } from 'vitest'

import type { Logger } from 'pino'

import type { Clock, RateLimiter } from '../../core/types.js'
import type { ExchangeConfig } from '../../config/types.js'
import type { CcxtExchange, CcxtOrder } from '../../../exchanges/types.js'
import { makeBtcPerp } from '../../test-helpers/ccxtMock.js'
import { MetricsRegistry, registerRestMetrics } from '../../observability/metrics.js'
import { createBybitRestAdapter } from './bybit.js'
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
    exchange: 'bybit',
    enabled: true,
    credentialsEnvPrefix: 'BYBIT',
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
  exchange: 'bybit',
  makeAdapter: (ccxtOverrides) => {
    const mockCcxt = makeMockCcxt(ccxtOverrides)
    const limiter = makeMockLimiter()
    const registry = new MetricsRegistry()
    const metrics = registerRestMetrics(registry)
    const adapter = createBybitRestAdapter({
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
  duplicateOrderCode: '110071',
  sampleSymbol: 'BTCUSDT',
  sampleCcxtSymbol: 'BTC/USDT:USDT',
  clientOrderIdParam: 'orderLinkId',
})

// Bybit-specific getOrder tests — covers the open→history fallback that replaces
// the default fetchOrder path (which throws ArgumentsRequired on Bybit).
describe('bybit getOrder via open→history fallback', () => {
  function makeAdapterWithMocks(
    openOrders: ReturnType<typeof makeOrderRaw>[],
    closedOrders: ReturnType<typeof makeOrderRaw>[]
  ) {
    const mockCcxt = makeMockCcxt({
      fetchOpenOrders: vi.fn().mockResolvedValue(openOrders),
      fetchClosedOrders: vi.fn().mockResolvedValue(closedOrders),
    })
    const registry = new MetricsRegistry()
    const metrics = registerRestMetrics(registry)
    const adapter = createBybitRestAdapter({
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

  it('returns open order immediately — does not call fetchClosedOrders', async () => {
    const openOrder = makeOrderRaw({ clientOrderId: 'sl-cid', status: 'open' })
    const { adapter, ccxt } = makeAdapterWithMocks([openOrder], [])

    const order = await adapter.getOrder({ symbol: 'BTCUSDT', clientOrderId: 'sl-cid' })

    expect(order).toBeDefined()
    expect(order?.status).toBe('new')
    expect(vi.mocked(ccxt.fetchOpenOrders)).toHaveBeenCalledWith(
      'BTC/USDT:USDT', undefined, undefined, { orderLinkId: 'sl-cid' }
    )
    expect(vi.mocked(ccxt.fetchClosedOrders)).not.toHaveBeenCalled()
  })

  it('falls back to fetchClosedOrders when not in open orders — returns filled order', async () => {
    const filledOrder = makeOrderRaw({ clientOrderId: 'sl-cid', status: 'closed', filled: 0.001 })
    const { adapter, ccxt } = makeAdapterWithMocks([], [filledOrder])

    const order = await adapter.getOrder({ symbol: 'BTCUSDT', clientOrderId: 'sl-cid' })

    expect(order).toBeDefined()
    expect(order?.status).toBe('filled')
    expect(vi.mocked(ccxt.fetchOpenOrders)).toHaveBeenCalledWith(
      'BTC/USDT:USDT', undefined, undefined, { orderLinkId: 'sl-cid' }
    )
    expect(vi.mocked(ccxt.fetchClosedOrders)).toHaveBeenCalledWith(
      'BTC/USDT:USDT', undefined, undefined, { orderLinkId: 'sl-cid' }
    )
  })

  it('returns undefined when order not found in either open or history', async () => {
    const { adapter } = makeAdapterWithMocks([], [])

    const order = await adapter.getOrder({ symbol: 'BTCUSDT', clientOrderId: 'sl-cid' })

    expect(order).toBeUndefined()
  })

  it('never calls fetchOrder (the path that throws ArgumentsRequired on Bybit)', async () => {
    const { adapter, ccxt } = makeAdapterWithMocks([], [])

    await adapter.getOrder({ symbol: 'BTCUSDT', clientOrderId: 'sl-cid' })

    expect(vi.mocked(ccxt.fetchOrder)).not.toHaveBeenCalled()
  })
})

describe('bybit stop_market triggerDirection', () => {
  function makeAdapter() {
    const mockCcxt = makeMockCcxt()
    const registry = new MetricsRegistry()
    const metrics = registerRestMetrics(registry)
    const adapter = createBybitRestAdapter({
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

  it('sell-side stop_market remaps to market+descending (closing long)', async () => {
    const { adapter, ccxt } = makeAdapter()
    await adapter.createOrder({
      intentId: 'i1',
      clientOrderId: 'sl-cid',
      exchange: 'bybit',
      symbol: 'BTCUSDT',
      side: 'sell',
      type: 'stop_market',
      qty: 0.001,
      stopPrice: 44000,
      reduceOnly: true,
    })
    // Bybit V5 only accepts orderType='Market'; triggerDirection+stopPrice carry the stop behaviour
    expect(vi.mocked(ccxt.createOrder)).toHaveBeenCalledWith(
      'BTC/USDT:USDT',
      'market',
      'sell',
      0.001,
      undefined,
      expect.objectContaining({ triggerDirection: 2, stopPrice: 44000 })
    )
  })

  it('buy-side stop_market remaps to market+ascending (closing short)', async () => {
    const { adapter, ccxt } = makeAdapter()
    await adapter.createOrder({
      intentId: 'i1',
      clientOrderId: 'sl-cid',
      exchange: 'bybit',
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'stop_market',
      qty: 0.001,
      stopPrice: 46000,
      reduceOnly: true,
    })
    expect(vi.mocked(ccxt.createOrder)).toHaveBeenCalledWith(
      'BTC/USDT:USDT',
      'market',
      'buy',
      0.001,
      undefined,
      expect.objectContaining({ triggerDirection: 1, stopPrice: 46000 })
    )
  })

  it('market order without stopPrice does not include triggerDirection', async () => {
    const { adapter, ccxt } = makeAdapter()
    await adapter.createOrder({
      intentId: 'i1',
      clientOrderId: 'cid-1',
      exchange: 'bybit',
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'market',
      qty: 0.001,
    })
    const params = vi.mocked(ccxt.createOrder).mock.calls[0]?.[5] as Record<string, unknown>
    expect(params).not.toHaveProperty('triggerDirection')
  })
})
