import { describe, expect, it, vi } from 'vitest'

import { toClickHouseDateTime } from '../db/types.js'
import type { MarketRow } from '../db/types.js'

const {
  mockExchange,
  insertFundingRatesMock,
  oldestFundingRateTimeMock,
  listFundingRateTimesByExchangeSymbolRangeMock,
} = vi.hoisted(() => {
  const insertFundingRatesMock = vi.fn()
  const oldestFundingRateTimeMock = vi.fn()
  const listFundingRateTimesByExchangeSymbolRangeMock = vi.fn()

  const mockExchange = {
    loadMarkets: vi.fn(async () => ({})),
    markets: {
      'BTC/USDT:USDT': {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT:USDT',
        info: { fundingIntervalHours: 8 },
      },
    },
    markets_by_id: {
      BTCUSDT: {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT:USDT',
        info: { fundingIntervalHours: 8 },
      },
    },
    market: vi.fn((symbol: string) => {
      return (mockExchange as { markets: Record<string, unknown> }).markets[symbol]
    }),
    has: { fetchFundingRateHistory: true },
    rateLimit: 10,
    fetchFundingRateHistory: vi.fn(async () => {
      const base = Date.UTC(2025, 0, 1, 0, 0, 0)
      return [
        {
          symbol: 'BTC/USDT:USDT',
          timestamp: base,
          fundingRate: 0.0001,
          info: {},
        },
        {
          symbol: 'BTC/USDT:USDT',
          timestamp: base + 8 * 60 * 60 * 1000,
          fundingRate: 0.0002,
          info: {},
        },
      ]
    }),
  }

  return {
    mockExchange,
    insertFundingRatesMock,
    oldestFundingRateTimeMock,
    listFundingRateTimesByExchangeSymbolRangeMock,
  }
})

vi.mock('../config/index.js', () => ({
  DATA_PERIOD_START: new Date('2025-01-01T00:00:00Z'),
  DATA_PERIOD_END: new Date('2025-01-02T00:00:00Z'),
  EXCHANGE_SYNC_CONCURRENCY: 1,
  FUNDING_RATE_SYMBOL_CONCURRENCY: 2,
  FUNDING_RATE_BACKOFF_BASE_MS: 1,
  FUNDING_RATE_BACKOFF_MAX_MS: 10,
  FUNDING_RATE_MAX_PAGES: 2,
  FUNDING_RATE_MAX_RETRIES: 1,
  FUNDING_RATE_PAGE_SIZE: 100,
  FUNDING_RATE_WINDOW_DAYS: 1,
}))

vi.mock('../exchanges/index.js', () => ({
  EXCHANGE_CONFIGS: [{ name: 'binance', ccxtId: 'binanceusdm' }],
}))

vi.mock('../exchanges/ccxt-client.js', () => ({
  createCcxtExchange: () => mockExchange,
}))

vi.mock('../db/health.js', () => ({
  assertClickHouseHealthy: vi.fn(async () => {}),
}))

vi.mock('../db/queries/markets.js', () => ({
  listMarketsByExchange: vi.fn(async () => [
    {
      exchange: 'binance',
      symbol: 'BTCUSDT',
      exchange_symbol: 'BTCUSDT',
      type: 'perpetual',
      listing_date: toClickHouseDateTime(new Date('2024-12-31T00:00:00Z')),
      delisting_date: null,
      is_active: true,
    },
  ]),
}))

vi.mock('../db/queries/fundingRates.js', () => ({
  getOldestFundingRateTime: oldestFundingRateTimeMock,
  listFundingRateCompletenessGaps: vi.fn(async () => []),
  listFundingRateTimesByExchangeSymbolRange:
    listFundingRateTimesByExchangeSymbolRangeMock,
  insertFundingRates: insertFundingRatesMock,
}))

describe('funding rate sync', () => {
  it('builds okx backward request using after cursor', async () => {
    const { buildBackwardFetchRequest } = await import('./funding-rates-sync.js')

    const request = buildBackwardFetchRequest(
      { mode: 'beforeSince', maxLimit: 100 },
      1_770_249_600_000,
      1_770_163_200_000,
      8 * 60 * 60 * 1000
    )

    expect(request).toEqual({
      since: undefined,
      limit: 100,
      params: { after: 1_770_249_599_999 },
    })
  })

  it('builds until mode request with since parameter to limit range', async () => {
    const { buildBackwardFetchRequest } = await import('./funding-rates-sync.js')

    const cursorEndMs = 1_770_249_600_000 // 2025-01-01 00:00:00 UTC
    const startMs = 1_770_163_200_000 // 2024-12-31 00:00:00 UTC
    const intervalMs = 8 * 60 * 60 * 1000 // 8 hours
    const limit = 100
    const windowMs = limit * intervalMs // 100 * 8 hours = 800 hours

    const request = buildBackwardFetchRequest(
      { mode: 'until', maxLimit: 100 },
      cursorEndMs,
      startMs,
      intervalMs
    )

    // The since should be max(startMs, cursorEndMs - windowMs)
    // Since cursorEndMs - windowMs would be way before startMs, since should be startMs
    const expectedSince = Math.max(startMs, cursorEndMs - windowMs)

    expect(request).toEqual({
      since: expectedSince,
      limit: 100,
      params: { until: cursorEndMs - 1 },
    })
    expect(request.since).toBeGreaterThanOrEqual(startMs)
    expect(request.since).toBeLessThanOrEqual(cursorEndMs)
  })

  it('resumes from oldest stored timestamp inside range', async () => {
    oldestFundingRateTimeMock.mockResolvedValueOnce(
      toClickHouseDateTime(new Date(Date.UTC(2025, 0, 1, 8, 0, 0)))
    )
    listFundingRateTimesByExchangeSymbolRangeMock.mockResolvedValueOnce([])

    const { syncFundingRates } = await import('./funding-rates-sync.js')

    await syncFundingRates()

    expect(insertFundingRatesMock).toHaveBeenCalledTimes(1)
    const rows = insertFundingRatesMock.mock.calls[0][0]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      exchange: 'binance',
      symbol: 'BTCUSDT',
      exchange_symbol: 'BTCUSDT',
      funding_rate: '0.00010000',
    })
  })

  it('inserts only missing funding rates', async () => {
    insertFundingRatesMock.mockClear()
    oldestFundingRateTimeMock.mockResolvedValueOnce(
      toClickHouseDateTime(new Date(Date.UTC(2024, 11, 31, 16, 0, 0)))
    )
    listFundingRateTimesByExchangeSymbolRangeMock.mockResolvedValueOnce([])

    const { syncFundingRates } = await import('./funding-rates-sync.js')

    await syncFundingRates()

    expect(insertFundingRatesMock).toHaveBeenCalledTimes(1)
    const rows = insertFundingRatesMock.mock.calls[0][0]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      exchange: 'binance',
      symbol: 'BTCUSDT',
      exchange_symbol: 'BTCUSDT',
      funding_rate: '0.00010000',
    })
  })

  it('resolves alias symbols using exchange_symbol and loaded market id', async () => {
    const { buildUnifiedSymbolResolver } = await import('./funding-rates-sync.js')
    const exchange = {
      markets: {
        'DEGEN/USDT:USDT': {
          id: 'DEGENUSDT',
          symbol: 'DEGEN/USDT:USDT',
          swap: true,
          linear: true,
          info: {},
        },
      },
    } as unknown as Parameters<typeof buildUnifiedSymbolResolver>[0]

    const resolve = buildUnifiedSymbolResolver(exchange)
    const market = {
      exchange: 'bitget',
      symbol: 'DEGENREBORNUSDT',
      exchange_symbol: 'DEGENUSDT',
      type: 'perpetual',
      listing_date: null,
      delisting_date: null,
      is_active: true,
    } satisfies MarketRow

    expect(resolve(market)).toBe('DEGEN/USDT:USDT')
  })

  it('treats known bitget removed-symbol error as skippable', async () => {
    const { isSkippableFundingRateError } = await import('./funding-rates-sync.js')
    const error = new Error(
      'bitget {"code":"40309","msg":"The symbol has been removed","requestTime":1770400978331,"data":null}'
    )

    expect(isSkippableFundingRateError('bitget', error)).toBe(true)
  })
})
