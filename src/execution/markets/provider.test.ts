import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from 'pino'

import type { CcxtMarket } from '../../exchanges/types.js'
import type { ExchangeConfig } from '../config/types.js'
import type { MarketMetadataDelta } from './types.js'
import { makeBtcPerp, makeEthPerp, makePerpMarket } from '../test-helpers/ccxtMock.js'

const { MockEx, ccxtMock } = vi.hoisted(() => {
  class MockEx {
    static setup: Record<string, { markets?: Record<string, CcxtMarket>; error?: Error }> = {}
    static reset(): void {
      MockEx.setup = {}
    }

    private readonly ccxtId: string
    markets: Record<string, CcxtMarket> = {}

    constructor(ccxtId: string) {
      this.ccxtId = ccxtId
    }

    loadMarkets(): Promise<Record<string, CcxtMarket>> {
      const s = MockEx.setup[this.ccxtId]
      if (s?.error) return Promise.reject(s.error)
      this.markets = s?.markets ?? {}
      return Promise.resolve(this.markets)
    }
  }

  const ccxtMock = new Proxy({} as Record<string, unknown>, {
    get: (_, id: string) =>
      class extends MockEx {
        constructor() {
          super(id)
        }
      },
  })

  return { MockEx, ccxtMock }
})

vi.mock('ccxt', () => ({ default: ccxtMock }))

import { createEventBus } from '../core/bus.js'
import { MetricsRegistry, registerMarketsMetrics } from '../observability/metrics.js'
import { createMarketMetadataProvider } from './provider.js'

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger
}

type SupportedExchange = 'binance' | 'bitget'

function makeExchangeConfig(exchange: SupportedExchange): ExchangeConfig {
  return {
    exchange,
    enabled: true,
    credentialsEnvPrefix: exchange.toUpperCase(),
    marketRefreshMs: 60_000,
    fundingPullMs: 15_000,
    rateLimits: { criticalReservationFraction: 0.1, criticalWindowSeconds: 60, buckets: [] },
  }
}

function makeOptions(exchanges: SupportedExchange[] = ['binance', 'bitget']) {
  const bus = createEventBus()
  const registry = new MetricsRegistry()
  const metrics = registerMarketsMetrics(registry)
  const logger = makeLogger()
  const exchangeConfigs = exchanges.map(makeExchangeConfig)
  return { bus, metrics, logger, exchangeConfigs }
}

describe('MarketMetadataProvider', () => {
  beforeEach(() => {
    MockEx.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initial refresh populates binance and bitget; markets.updated fires per exchange', async () => {
    MockEx.setup.binanceusdm = { markets: { BTCUSDT: makeBtcPerp(), ETHUSDT: makeEthPerp() } }
    MockEx.setup.bitget = { markets: { BTCUSDT: makeBtcPerp() } }

    const { bus, metrics, logger, exchangeConfigs } = makeOptions()
    const updateEvents: MarketMetadataDelta[] = []
    bus.on('markets.updated', d => updateEvents.push(d))

    const { provider, start, stop } = createMarketMetadataProvider({
      bus,
      logger,
      metrics,
      exchanges: exchangeConfigs,
    })
    await start()

    expect(provider.list('binance')).toHaveLength(2)
    expect(provider.list('bitget')).toHaveLength(1)

    const btc = provider.get('binance', 'BTCUSDT')
    expect(btc).toBeDefined()
    expect(btc?.symbol).toBe('BTCUSDT')
    expect(btc?.exchange).toBe('binance')
    expect(btc?.status).toBe('trading')

    expect(updateEvents).toHaveLength(2)
    const binanceEvent = updateEvents.find(e => e.added.some(m => m.exchange === 'binance'))
    expect(binanceEvent?.added).toHaveLength(2)
    expect(binanceEvent?.removed).toHaveLength(0)
    expect(binanceEvent?.changed).toHaveLength(0)

    await stop()
  })

  it('second refresh emits delta with added, removed, changed markets', async () => {
    MockEx.setup.binanceusdm = {
      markets: {
        BTCUSDT: makeBtcPerp(),
        ETHUSDT: makeEthPerp(),
      },
    }
    MockEx.setup.bitget = { markets: {} }

    const { bus, metrics, logger, exchangeConfigs } = makeOptions(['binance'])
    const updates: MarketMetadataDelta[] = []
    bus.on('markets.updated', d => updates.push(d))

    const { provider, start, stop } = createMarketMetadataProvider({
      bus,
      logger,
      metrics,
      exchanges: exchangeConfigs.filter(e => e.exchange === 'binance'),
    })
    await start()
    expect(provider.list('binance')).toHaveLength(2)

    MockEx.setup.binanceusdm = {
      markets: {
        BTCUSDT: makeBtcPerp({ precision: { price: 4, amount: 3 } }),
        SOLUSDT: makePerpMarket('SOLUSDT', 'SOL/USDT:USDT'),
      },
    }
    await provider.refresh('binance')

    expect(provider.list('binance')).toHaveLength(2)
    const lastUpdate = updates.at(-1)
    expect(lastUpdate?.added.map(m => m.symbol)).toContain('SOLUSDT')
    expect(lastUpdate?.removed.map(m => m.symbol)).toContain('ETHUSDT')
    expect(lastUpdate?.changed.map(m => m.symbol)).toContain('BTCUSDT')

    await stop()
  })

  it('bitget failure does not degrade binance; error counter incremented', async () => {
    MockEx.setup.binanceusdm = { markets: { BTCUSDT: makeBtcPerp() } }
    MockEx.setup.bitget = { error: new Error('network timeout') }

    const { bus, logger, exchangeConfigs } = makeOptions()
    const registry = new MetricsRegistry()
    const m = registerMarketsMetrics(registry)

    const { provider, start, stop } = createMarketMetadataProvider({
      bus,
      logger,
      metrics: m,
      exchanges: exchangeConfigs,
    })
    await start()

    expect(provider.list('binance')).toHaveLength(1)
    expect(provider.list('bitget')).toHaveLength(0)

    const rendered = await registry.render()
    expect(rendered).toMatch(/markets_refresh_total\{exchange="bitget",status="error"\} 1/)
    expect(rendered).toMatch(/markets_refresh_total\{exchange="binance",status="ok"\} 1/)

    await stop()
  })

  it('records refresh metrics on success', async () => {
    MockEx.setup.binanceusdm = { markets: { BTCUSDT: makeBtcPerp() } }

    const { bus, logger, exchangeConfigs } = makeOptions(['binance'])
    const registry = new MetricsRegistry()
    const metrics = registerMarketsMetrics(registry)

    const { start, stop } = createMarketMetadataProvider({
      bus,
      logger,
      metrics,
      exchanges: exchangeConfigs.filter(e => e.exchange === 'binance'),
    })
    await start()

    const rendered = await registry.render()
    expect(rendered).toMatch(/markets_refresh_total\{exchange="binance",status="ok"\} 1/)
    expect(rendered).toMatch(/markets_refresh_duration_ms_count\{exchange="binance"\} 1/)
    expect(rendered).toMatch(/markets_total\{exchange="binance",status="trading"\} 1/)

    await stop()
  })

  it('start() schedules recurring refreshes; counter increments on tick', async () => {
    vi.useFakeTimers()
    MockEx.setup.binanceusdm = { markets: { BTCUSDT: makeBtcPerp() } }

    const { bus, logger } = makeOptions(['binance'])
    const registry = new MetricsRegistry()
    const metrics = registerMarketsMetrics(registry)

    const refreshMs = 60_000
    const cfg = makeExchangeConfig('binance')
    cfg.marketRefreshMs = refreshMs
    const { start, stop } = createMarketMetadataProvider({
      bus,
      logger,
      metrics,
      exchanges: [cfg],
    })

    await start()

    let rendered = await registry.render()
    expect(rendered).toMatch(/markets_refresh_total\{exchange="binance",status="ok"\} 1/)

    await vi.advanceTimersByTimeAsync(refreshMs)

    rendered = await registry.render()
    expect(rendered).toMatch(/markets_refresh_total\{exchange="binance",status="ok"\} 2/)

    await stop()
  })

  it('stop() clears timers so no refresh fires after stop', async () => {
    vi.useFakeTimers()
    MockEx.setup.binanceusdm = { markets: { BTCUSDT: makeBtcPerp() } }

    const { bus, logger } = makeOptions(['binance'])
    const registry = new MetricsRegistry()
    const metrics = registerMarketsMetrics(registry)

    const refreshMs = 60_000
    const cfg = makeExchangeConfig('binance')
    cfg.marketRefreshMs = refreshMs
    const { start, stop } = createMarketMetadataProvider({
      bus,
      logger,
      metrics,
      exchanges: [cfg],
    })

    await start()
    await stop()

    await vi.advanceTimersByTimeAsync(refreshMs * 3)

    const rendered = await registry.render()
    expect(rendered).toMatch(/markets_refresh_total\{exchange="binance",status="ok"\} 1/)
  })

  it('no delta event emitted when markets are unchanged on second refresh', async () => {
    const btc = makeBtcPerp()
    MockEx.setup.binanceusdm = { markets: { BTCUSDT: btc } }

    const { bus, metrics, logger, exchangeConfigs } = makeOptions(['binance'])
    const updates: MarketMetadataDelta[] = []
    bus.on('markets.updated', d => updates.push(d))

    const { provider, start, stop } = createMarketMetadataProvider({
      bus,
      logger,
      metrics,
      exchanges: exchangeConfigs.filter(e => e.exchange === 'binance'),
    })
    await start()

    const countAfterInit = updates.length
    await provider.refresh('binance')

    expect(updates.length).toBe(countAfterInit)

    await stop()
  })
})
