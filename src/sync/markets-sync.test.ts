import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ExchangeConfig, ExchangeName, Market } from '../exchanges/types.js'
import type { ExchangeSymbolResolver } from '../exchanges/symbol-resolver.js'

const exchangeConfigsRef = vi.hoisted(() => ({
  configs: [] as ExchangeConfig[]
}))

const fetchActiveMarketsMock = vi.hoisted(() =>
  vi.fn<(config: ExchangeConfig) => Promise<Market[]>>()
)
const loadDelistingsMock = vi.hoisted(() =>
  vi.fn<(exchange: string, resolver?: ExchangeSymbolResolver) => Promise<Market[]>>()
)
const createExchangeSymbolResolverMock = vi.hoisted(() =>
  vi.fn<(exchange: ExchangeName, activeMarkets: Market[]) => ExchangeSymbolResolver>()
)
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../exchanges/index.js', () => ({
  EXCHANGE_CONFIGS: exchangeConfigsRef.configs
}))

vi.mock('../exchanges/fetcher.js', () => ({
  fetchActiveMarkets: fetchActiveMarketsMock
}))

vi.mock('../exchanges/symbol-resolver.js', () => ({
  createExchangeSymbolResolver: createExchangeSymbolResolverMock
}))

vi.mock('./delistings-loader.js', () => ({
  loadDelistingsForExchange: loadDelistingsMock
}))

vi.mock('../logger.js', () => ({
  logger: loggerMock,
}))

import { syncMarkets } from './markets-sync.js'

describe('syncMarkets', () => {
  beforeEach(() => {
    exchangeConfigsRef.configs.length = 0
    fetchActiveMarketsMock.mockReset()
    loadDelistingsMock.mockReset()
    createExchangeSymbolResolverMock.mockReset()
    loggerMock.info.mockReset()
    loggerMock.warn.mockReset()
    loggerMock.error.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('merges active and delisted markets, preferring active entries', async () => {
    exchangeConfigsRef.configs.push({
      name: 'binance',
      ccxtId: 'binanceusdm'
    })

    const activeMarkets: Market[] = [
      {
        exchange: 'binance',
        symbol: 'BTCUSDT',
        exchange_symbol: 'BTCUSDT',
        type: 'perpetual',
        listing_date: null,
        delisting_date: null,
        is_active: true
      },
      {
        exchange: 'binance',
        symbol: 'ETHUSDT',
        exchange_symbol: 'ETHUSDT',
        type: 'perpetual',
        listing_date: null,
        delisting_date: null,
        is_active: true
      }
    ]

    const delistedMarkets: Market[] = [
      {
        exchange: 'binance',
        symbol: 'BTCUSDT',
        exchange_symbol: 'BTCUSDT',
        type: 'perpetual',
        listing_date: null,
        delisting_date: new Date('2026-02-06T09:00:00.000Z'),
        is_active: false
      }
    ]

    fetchActiveMarketsMock.mockResolvedValue(activeMarkets)
    loadDelistingsMock.mockResolvedValue(delistedMarkets)
    createExchangeSymbolResolverMock.mockReturnValue({
      exchange: 'binance',
      getExchangeSymbol: (symbol: string) => symbol
    })

    const merged = await syncMarkets()

    const config = exchangeConfigsRef.configs[0]
    if (!config) {
      throw new Error('Expected exchange config')
    }
    expect(fetchActiveMarketsMock).toHaveBeenCalledWith(config)
    expect(createExchangeSymbolResolverMock).toHaveBeenCalledWith(
      'binance',
      activeMarkets
    )
    const resolverResult = createExchangeSymbolResolverMock.mock.results[0]
    if (resolverResult?.type !== 'return') {
      throw new Error('Expected exchange symbol resolver')
    }
    const resolver = resolverResult.value
    expect(loadDelistingsMock).toHaveBeenCalledWith('binance', resolver)

    expect(merged).toHaveLength(2)

    const btc = merged.find((market) => market.symbol === 'BTCUSDT')
    const eth = merged.find((market) => market.symbol === 'ETHUSDT')

    expect(btc?.is_active).toBe(true)
    expect(btc?.delisting_date).toBeNull()
    expect(eth?.is_active).toBe(true)
  })

  it('continues syncing when active market fetch fails', async () => {
    exchangeConfigsRef.configs.push(
      { name: 'binance', ccxtId: 'binanceusdm' },
      { name: 'bybit', ccxtId: 'bybit' }
    )

    fetchActiveMarketsMock.mockImplementation((config: ExchangeConfig) => {
      if (config.name === 'binance') {
        throw new Error('boom')
      }
      return Promise.resolve([
        {
          exchange: 'bybit',
          symbol: 'SOLUSDT',
          exchange_symbol: 'SOLUSDT',
          type: 'perpetual',
          listing_date: null,
          delisting_date: null,
          is_active: true
        }
      ])
    })

    loadDelistingsMock.mockImplementation((exchange: string) => {
      if (exchange === 'binance') {
        return Promise.resolve([
          {
            exchange: 'binance',
            symbol: 'FOOUSDT',
            exchange_symbol: 'FOOUSDT',
            type: 'perpetual',
            listing_date: null,
            delisting_date: new Date('2026-02-06T09:00:00.000Z'),
            is_active: false
          }
        ])
      }
      return Promise.resolve([])
    })

    createExchangeSymbolResolverMock.mockReturnValue({
      exchange: 'binance',
      getExchangeSymbol: (symbol: string) => symbol
    })

    const merged = await syncMarkets()

    expect(fetchActiveMarketsMock).toHaveBeenCalledTimes(2)
    expect(createExchangeSymbolResolverMock).toHaveBeenCalledWith(
      'binance',
      []
    )

    expect(merged).toHaveLength(2)

    const foo = merged.find((market) => market.symbol === 'FOOUSDT')
    const sol = merged.find((market) => market.symbol === 'SOLUSDT')

    expect(foo?.is_active).toBe(false)
    expect(sol?.is_active).toBe(true)
  })
})
