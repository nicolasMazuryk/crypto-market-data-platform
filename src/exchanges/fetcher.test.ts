import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CcxtMarket, ExchangeConfig } from './types.js'

const { MockExchange, ccxtMock } = vi.hoisted(() => {
  class MockExchange {
    static nextMarkets: Record<string, CcxtMarket> = {}
    static lastConfig: Record<string, unknown> | null = null
    markets: Record<string, CcxtMarket>

    constructor(config?: Record<string, unknown>) {
      MockExchange.lastConfig = config ?? null
      this.markets = MockExchange.nextMarkets
    }

    loadMarkets(): Promise<Record<string, CcxtMarket>> {
      return Promise.resolve(this.markets)
    }
  }

  return {
    MockExchange,
    ccxtMock: {
      testexchange: MockExchange,
    },
  }
})

vi.mock('ccxt', () => ({
  default: ccxtMock,
}))

import { fetchActiveMarkets } from './fetcher.js'

describe('fetchActiveMarkets', () => {
  beforeEach(() => {
    MockExchange.nextMarkets = {}
    MockExchange.lastConfig = null
  })

  it('filters for active USDT perpetual swaps and maps market fields', async () => {
    MockExchange.nextMarkets = {
      BTCUSDT: {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT:USDT',
        swap: true,
        linear: true,
        settle: 'USDT',
        active: true,
        info: { onboardDate: 1700000000000 },
      },
      ETHUSDT: {
        id: 'ETHUSDT',
        symbol: 'ETH/USDT:USDT',
        swap: true,
        linear: true,
        settle: 'USDT',
        info: { onboardDate: 1700000001000 },
      },
      XRPUSDT: {
        id: 'XRPUSDT',
        symbol: 'XRP/USDT:USDT',
        swap: false,
        linear: true,
        settle: 'USDT',
        active: true,
      },
      ADAUSDC: {
        id: 'ADAUSDC',
        symbol: 'ADA/USDC:USDC',
        swap: true,
        linear: true,
        settle: 'USDC',
        active: true,
      },
      DOGEUSDT: {
        id: 'DOGEUSDT',
        symbol: 'DOGE/USDT:USDT',
        swap: true,
        linear: false,
        settle: 'USDT',
        active: true,
      },
      SOLUSDT: {
        id: 'SOLUSDT',
        symbol: 'SOL/USDT:USDT',
        swap: true,
        linear: true,
        settle: 'USDT',
        active: false,
      },
    }

    const exchangeConfig: ExchangeConfig = {
      name: 'binance',
      ccxtId: 'testexchange',
      options: { defaultType: 'swap' },
    }

    const markets = await fetchActiveMarkets(exchangeConfig)

    expect(MockExchange.lastConfig).toEqual({
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    })

    expect(markets).toHaveLength(2)

    const btc = markets.find(market => market.symbol === 'BTCUSDT')
    const eth = markets.find(market => market.symbol === 'ETHUSDT')

    expect(btc).toMatchObject({
      exchange: 'binance',
      symbol: 'BTCUSDT',
      exchange_symbol: 'BTCUSDT',
      type: 'perpetual',
      is_active: true,
    })
    expect(btc?.listing_date?.toISOString()).toBe(new Date(1700000000000).toISOString())

    expect(eth).toMatchObject({
      exchange: 'binance',
      symbol: 'ETHUSDT',
      exchange_symbol: 'ETHUSDT',
      type: 'perpetual',
      is_active: true,
    })
    expect(eth?.listing_date?.toISOString()).toBe(new Date(1700000001000).toISOString())
  })

  it('throws when the CCXT exchange id is not supported', async () => {
    const exchangeConfig: ExchangeConfig = {
      name: 'binance',
      ccxtId: 'missing',
    }

    await expect(fetchActiveMarkets(exchangeConfig)).rejects.toThrow('Unsupported CCXT exchange id')
  })
})
