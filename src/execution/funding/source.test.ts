import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from 'pino'

import type { CcxtFundingRate, CcxtMarket } from '../../exchanges/types.js'
import type { ExchangeConfig } from '../config/types.js'

const { MockEx, ccxtMock } = vi.hoisted(() => {
  class MockEx {
    static setup: Record<
      string,
      {
        markets?: Record<string, CcxtMarket>
        rates?: Record<string, CcxtFundingRate>
        error?: Error
      }
    > = {}

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

    fetchFundingRates(): Promise<Record<string, CcxtFundingRate>> {
      const s = MockEx.setup[this.ccxtId]
      if (s?.error) return Promise.reject(s.error)
      return Promise.resolve(s?.rates ?? {})
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
import { MetricsRegistry, registerFundingMetrics } from '../observability/metrics.js'
import { createFundingRateSource } from './source.js'
import type { FundingSnapshot } from './types.js'

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

function makePerpMarket(id: string, symbol: string): CcxtMarket {
  return { id, symbol, swap: true, linear: true, settle: 'USDT', active: true }
}

function makeFundingRate(symbol: string, overrides: Partial<CcxtFundingRate> = {}): CcxtFundingRate {
  return {
    symbol,
    fundingRate: 0.0001,
    fundingTimestamp: 1_700_000_000_000,
    fundingDatetime: new Date(1_700_000_000_000).toISOString(),
    interval: '8h',
    info: {},
    ...overrides,
  }
}

function makeOptions(exchanges: SupportedExchange[] = ['binance', 'bitget']) {
  const bus = createEventBus()
  const registry = new MetricsRegistry()
  const metrics = registerFundingMetrics(registry)
  const logger = makeLogger()
  const exchangeConfigs = exchanges.map(makeExchangeConfig)
  return { bus, registry, metrics, logger, exchangeConfigs }
}

describe('FundingRateSource', () => {
  beforeEach(() => {
    MockEx.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initial pull populates store for both exchanges', async () => {
    MockEx.setup.binanceusdm = {
      markets: { 'BTC/USDT:USDT': makePerpMarket('BTCUSDT', 'BTC/USDT:USDT') },
      rates: { 'BTC/USDT:USDT': makeFundingRate('BTC/USDT:USDT') },
    }
    MockEx.setup.bitget = {
      markets: { 'ETH/USDT:USDT': makePerpMarket('ETHUSDT', 'ETH/USDT:USDT') },
      rates: { 'ETH/USDT:USDT': makeFundingRate('ETH/USDT:USDT') },
    }

    const { bus, metrics, logger, exchangeConfigs } = makeOptions()
    const handle = createFundingRateSource({ bus, logger, metrics, exchanges: exchangeConfigs })
    await handle.source.start()

    expect(handle.source.latest('binance').size).toBe(1)
    expect(handle.source.latest('binance').get('BTCUSDT')?.fundingRate).toBe(0.0001)
    expect(handle.source.latest('bitget').size).toBe(1)

    await handle.stop()
  })

  it('second pull with same data emits no new snapshot; changed rate does emit', async () => {
    vi.useFakeTimers()
    MockEx.setup.binanceusdm = {
      markets: { 'BTC/USDT:USDT': makePerpMarket('BTCUSDT', 'BTC/USDT:USDT') },
      rates: { 'BTC/USDT:USDT': makeFundingRate('BTC/USDT:USDT', { fundingRate: 0.0001 }) },
    }

    const { bus, metrics, logger } = makeOptions(['binance'])
    const snapshots: FundingSnapshot[] = []
    bus.on('funding.snapshot', s => snapshots.push(s))

    const cfg = makeExchangeConfig('binance')
    const handle = createFundingRateSource({ bus, logger, metrics, exchanges: [cfg] })
    await handle.source.start()
    expect(snapshots).toHaveLength(1)

    // Second tick — same rate, same nextFundingTimestamp → no new event
    await vi.advanceTimersByTimeAsync(15_000)
    expect(snapshots).toHaveLength(1)

    // Third tick — changed funding rate → new event
    MockEx.setup.binanceusdm.rates = {
      'BTC/USDT:USDT': makeFundingRate('BTC/USDT:USDT', { fundingRate: 0.0005 }),
    }
    await vi.advanceTimersByTimeAsync(15_000)
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1]?.fundingRate).toBe(0.0005)

    await handle.stop()
  })

  it('funding.snapshot events are emitted on initial pull', async () => {
    MockEx.setup.binanceusdm = {
      markets: {
        'BTC/USDT:USDT': makePerpMarket('BTCUSDT', 'BTC/USDT:USDT'),
        'ETH/USDT:USDT': makePerpMarket('ETHUSDT', 'ETH/USDT:USDT'),
      },
      rates: {
        'BTC/USDT:USDT': makeFundingRate('BTC/USDT:USDT'),
        'ETH/USDT:USDT': makeFundingRate('ETH/USDT:USDT'),
      },
    }

    const { bus, metrics, logger, exchangeConfigs } = makeOptions(['binance'])
    const snapshots: FundingSnapshot[] = []
    bus.on('funding.snapshot', s => snapshots.push(s))

    const handle = createFundingRateSource({
      bus,
      logger,
      metrics,
      exchanges: exchangeConfigs.filter(e => e.exchange === 'binance'),
    })
    await handle.source.start()

    expect(snapshots).toHaveLength(2)
    expect(snapshots.map(s => s.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT'])

    await handle.stop()
  })

  it('bitget failure does not affect binance store', async () => {
    MockEx.setup.binanceusdm = {
      markets: { 'BTC/USDT:USDT': makePerpMarket('BTCUSDT', 'BTC/USDT:USDT') },
      rates: { 'BTC/USDT:USDT': makeFundingRate('BTC/USDT:USDT') },
    }
    MockEx.setup.bitget = { error: new Error('network timeout') }

    const { bus, metrics, logger, exchangeConfigs } = makeOptions()
    const handle = createFundingRateSource({ bus, logger, metrics, exchanges: exchangeConfigs })
    await handle.source.start()

    expect(handle.source.latest('binance').size).toBe(1)
    expect(handle.source.latest('bitget').size).toBe(0)

    await handle.stop()
  })

  it('metrics are incremented on successful pull', async () => {
    MockEx.setup.binanceusdm = {
      markets: { 'BTC/USDT:USDT': makePerpMarket('BTCUSDT', 'BTC/USDT:USDT') },
      rates: { 'BTC/USDT:USDT': makeFundingRate('BTC/USDT:USDT') },
    }

    const { bus, metrics, logger, exchangeConfigs, registry } = makeOptions(['binance'])
    const handle = createFundingRateSource({
      bus,
      logger,
      metrics,
      exchanges: exchangeConfigs.filter(e => e.exchange === 'binance'),
    })
    await handle.source.start()

    const rendered = await registry.render()
    expect(rendered).toMatch(/funding_pull_total\{exchange="binance",status="ok"\} 1/)
    expect(rendered).toMatch(/funding_pull_duration_ms_count\{exchange="binance"\} 1/)
    expect(rendered).toMatch(/funding_snapshots_total\{exchange="binance"\} 1/)

    await handle.stop()
  })

  it('error counter incremented on pull failure', async () => {
    MockEx.setup.binanceusdm = { error: new Error('api error') }

    const { bus, metrics, logger, exchangeConfigs, registry } = makeOptions(['binance'])
    const handle = createFundingRateSource({
      bus,
      logger,
      metrics,
      exchanges: exchangeConfigs.filter(e => e.exchange === 'binance'),
    })
    await handle.source.start()

    const rendered = await registry.render()
    expect(rendered).toMatch(/funding_pull_total\{exchange="binance",status="error"\} 1/)

    await handle.stop()
  })

  it('start() schedules recurring pulls; counter increments on each tick', async () => {
    vi.useFakeTimers()
    MockEx.setup.binanceusdm = {
      markets: { 'BTC/USDT:USDT': makePerpMarket('BTCUSDT', 'BTC/USDT:USDT') },
      rates: { 'BTC/USDT:USDT': makeFundingRate('BTC/USDT:USDT') },
    }

    const { bus, metrics, logger, registry } = makeOptions(['binance'])
    const fundingPullMs = 15_000
    const cfg = makeExchangeConfig('binance')
    cfg.fundingPullMs = fundingPullMs

    const handle = createFundingRateSource({
      bus,
      logger,
      metrics,
      exchanges: [cfg],
    })
    await handle.source.start()

    let rendered = await registry.render()
    expect(rendered).toMatch(/funding_pull_total\{exchange="binance",status="ok"\} 1/)

    await vi.advanceTimersByTimeAsync(fundingPullMs)

    rendered = await registry.render()
    expect(rendered).toMatch(/funding_pull_total\{exchange="binance",status="ok"\} 2/)

    await handle.stop()
  })

  it('stop() clears timers so no pull fires after stop', async () => {
    vi.useFakeTimers()
    MockEx.setup.binanceusdm = {
      markets: { 'BTC/USDT:USDT': makePerpMarket('BTCUSDT', 'BTC/USDT:USDT') },
      rates: { 'BTC/USDT:USDT': makeFundingRate('BTC/USDT:USDT') },
    }

    const { bus, metrics, logger, registry } = makeOptions(['binance'])
    const handle = createFundingRateSource({
      bus,
      logger,
      metrics,
      exchanges: [makeExchangeConfig('binance')],
    })

    await handle.source.start()
    await handle.stop()

    await vi.advanceTimersByTimeAsync(15_000 * 5)

    const rendered = await registry.render()
    expect(rendered).toMatch(/funding_pull_total\{exchange="binance",status="ok"\} 1/)
  })

  it('malformed raw entries (missing fundingRate) are dropped without throwing', async () => {
    MockEx.setup.binanceusdm = {
      markets: {
        'BTC/USDT:USDT': makePerpMarket('BTCUSDT', 'BTC/USDT:USDT'),
        'ETH/USDT:USDT': makePerpMarket('ETHUSDT', 'ETH/USDT:USDT'),
      },
      rates: {
        'BTC/USDT:USDT': makeFundingRate('BTC/USDT:USDT'),
        'ETH/USDT:USDT': makeFundingRate('ETH/USDT:USDT', { fundingRate: undefined }),
      },
    }

    const { bus, metrics, logger, exchangeConfigs } = makeOptions(['binance'])
    const handle = createFundingRateSource({
      bus,
      logger,
      metrics,
      exchanges: exchangeConfigs.filter(e => e.exchange === 'binance'),
    })

    await expect(handle.source.start()).resolves.not.toThrow()
    expect(handle.source.latest('binance').size).toBe(1)
    expect(handle.source.latest('binance').has('BTCUSDT')).toBe(true)

    await handle.stop()
  })

  it('fundingTimeOverrideMs rewrites nextFundingTimestamp on every snapshot while preserving other fields', async () => {
    const overrideMs = 1_700_100_000_000
    MockEx.setup.binanceusdm = {
      markets: {
        'BTC/USDT:USDT': makePerpMarket('BTCUSDT', 'BTC/USDT:USDT'),
        'ETH/USDT:USDT': makePerpMarket('ETHUSDT', 'ETH/USDT:USDT'),
      },
      rates: {
        'BTC/USDT:USDT': makeFundingRate('BTC/USDT:USDT', { fundingRate: 0.0003 }),
        'ETH/USDT:USDT': makeFundingRate('ETH/USDT:USDT', { fundingRate: 0.0007 }),
      },
    }

    const { bus, metrics, logger } = makeOptions(['binance'])
    const handle = createFundingRateSource({
      bus,
      logger,
      metrics,
      exchanges: [makeExchangeConfig('binance')],
      fundingTimeOverrideMs: overrideMs,
    })
    await handle.source.start()

    const btc = handle.source.latest('binance').get('BTCUSDT')
    const eth = handle.source.latest('binance').get('ETHUSDT')

    expect(btc?.nextFundingTimestamp).toBe(overrideMs)
    expect(btc?.nextFundingDatetime).toBe(new Date(overrideMs).toISOString())
    expect(btc?.fundingRate).toBe(0.0003)

    expect(eth?.nextFundingTimestamp).toBe(overrideMs)
    expect(eth?.nextFundingDatetime).toBe(new Date(overrideMs).toISOString())
    expect(eth?.fundingRate).toBe(0.0007)

    await handle.stop()
  })

  it('fundingTimeOverrideMs increments overrideAppliedTotal metric', async () => {
    const overrideMs = 1_700_100_000_000
    MockEx.setup.binanceusdm = {
      markets: { 'BTC/USDT:USDT': makePerpMarket('BTCUSDT', 'BTC/USDT:USDT') },
      rates: { 'BTC/USDT:USDT': makeFundingRate('BTC/USDT:USDT') },
    }

    const { bus, metrics, logger, registry } = makeOptions(['binance'])
    const handle = createFundingRateSource({
      bus,
      logger,
      metrics,
      exchanges: [makeExchangeConfig('binance')],
      fundingTimeOverrideMs: overrideMs,
    })
    await handle.source.start()

    const rendered = await registry.render()
    expect(rendered).toMatch(/funding_override_applied_total\{exchange="binance"\} 1/)

    await handle.stop()
  })

  it('latest() returns a defensive copy so mutations do not affect internal store', async () => {
    MockEx.setup.binanceusdm = {
      markets: { 'BTC/USDT:USDT': makePerpMarket('BTCUSDT', 'BTC/USDT:USDT') },
      rates: { 'BTC/USDT:USDT': makeFundingRate('BTC/USDT:USDT') },
    }

    const { bus, metrics, logger, exchangeConfigs } = makeOptions(['binance'])
    const handle = createFundingRateSource({
      bus,
      logger,
      metrics,
      exchanges: exchangeConfigs.filter(e => e.exchange === 'binance'),
    })
    await handle.source.start()

    const copy = handle.source.latest('binance')
    copy.clear()

    expect(handle.source.latest('binance').size).toBe(1)

    await handle.stop()
  })
})
