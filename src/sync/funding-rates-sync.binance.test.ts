import { beforeEach, describe, expect, it, vi } from 'vitest'

import { toClickHouseDateTime } from '../db/types.js'

const {
  mockExchange,
  fetchFundingRateHistoryMock,
  insertFundingRatesMock,
  latestFundingRateTimeMock,
  oldestFundingRateTimeMock,
  listFundingRateTimesByExchangeSymbolRangeMock,
  fetchMock,
} = vi.hoisted(() => {
  const fetchFundingRateHistoryMock = vi.fn()
  const insertFundingRatesMock = vi.fn()
  const latestFundingRateTimeMock = vi.fn()
  const oldestFundingRateTimeMock = vi.fn()
  const listFundingRateTimesByExchangeSymbolRangeMock = vi.fn()
  const fetchMock = vi.fn()

  const mockExchange = {
    loadMarkets: vi.fn(() => Promise.resolve({})),
    markets: {
      'BTC/USDT:USDT': {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT:USDT',
        contract: true,
        swap: true,
        linear: true,
        info: { fundingIntervalHours: 8 },
      },
    } as Record<string, unknown>,
    markets_by_id: {
      BTCUSDT: {
        id: 'BTCUSDT',
        symbol: 'BTC/USDT:USDT',
        contract: true,
        swap: true,
        linear: true,
        info: { fundingIntervalHours: 8 },
      },
    } as Record<string, unknown>,
    market: vi.fn((symbol: string) => (mockExchange as { markets: Record<string, unknown> }).markets[symbol]),
    has: { fetchFundingRateHistory: true },
    rateLimit: 10,
    fetchFundingRateHistory: fetchFundingRateHistoryMock,
  }

  return {
    mockExchange,
    fetchFundingRateHistoryMock,
    insertFundingRatesMock,
    latestFundingRateTimeMock,
    oldestFundingRateTimeMock,
    listFundingRateTimesByExchangeSymbolRangeMock,
    fetchMock,
  }
})

// Archive CSV rows: calc_time, funding_interval_hours, last_funding_rate
function csvFor(rows: { ts: number; rate: number }[]): string {
  const header = 'calcTime,fundingIntervalHours,lastFundingRate'
  const lines = rows.map(r => `${String(r.ts)},8,${String(r.rate)}`)
  return [header, ...lines].join('\n')
}

vi.mock('unzipper', () => ({
  default: {
    Open: {
      buffer: vi.fn((zipBuffer: Buffer) => {
        const csvText = zipBuffer.toString('utf8')
        return Promise.resolve({
          files: [{ buffer: () => Promise.resolve(Buffer.from(csvText, 'utf8')) }],
        })
      }),
    },
  },
}))

vi.mock('../config/index.js', () => ({
  SYNC_DATA_PERIOD_START: new Date('2025-01-01T00:00:00Z'),
  SYNC_DATA_PERIOD_END: new Date('2025-03-15T00:00:00Z'),
  FUNDING_RATE_SYMBOL_CONCURRENCY: 2,
  FUNDING_RATE_BACKOFF_BASE_MS: 1,
  FUNDING_RATE_BACKOFF_MAX_MS: 10,
  FUNDING_RATE_MAX_RETRIES: 1,
  FUNDING_RATE_PAGE_SIZE: 100,
  FUNDING_RATE_SYNC_MODE: 'incremental',
}))

vi.mock('../exchanges/index.js', () => ({
  EXCHANGE_CONFIGS: [{ name: 'binance', ccxtId: 'binanceusdm' }],
}))

vi.mock('../exchanges/ccxt-client.js', () => ({
  createCcxtExchange: () => mockExchange,
}))

vi.mock('../db/health.js', () => ({
  assertClickHouseHealthy: vi.fn(() => Promise.resolve()),
}))

vi.mock('../db/queries/markets.js', () => ({
  listMarketsByExchange: vi.fn(() =>
    Promise.resolve([
      {
        exchange: 'binance',
        symbol: 'BTCUSDT',
        exchange_symbol: 'BTCUSDT',
        type: 'perpetual',
        listing_date: toClickHouseDateTime(new Date('2024-12-31T00:00:00Z')),
        delisting_date: null,
        is_active: true,
      },
    ])
  ),
}))

vi.mock('../db/queries/fundingRates.js', () => ({
  getLatestFundingRateTime: latestFundingRateTimeMock,
  getOldestFundingRateTime: oldestFundingRateTimeMock,
  listFundingRateCompletenessGaps: vi.fn(() => Promise.resolve([])),
  listFundingRateTimesByExchangeSymbolRange: listFundingRateTimesByExchangeSymbolRangeMock,
  insertFundingRates: insertFundingRatesMock,
  validateSymbolsForExchange: vi.fn(() =>
    Promise.resolve({
      isMatch: true,
      expectedSymbols: [],
      actualSymbols: [],
      missingSymbols: [],
      extraSymbols: [],
      exchange: '',
    })
  ),
}))

describe('binance funding sync: archive for completed months, CCXT for current-month tail', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    insertFundingRatesMock.mockClear()
    latestFundingRateTimeMock.mockReset()
    oldestFundingRateTimeMock.mockReset()
    listFundingRateTimesByExchangeSymbolRangeMock.mockReset()
    fetchFundingRateHistoryMock.mockReset()
    fetchMock.mockReset()
    listFundingRateTimesByExchangeSymbolRangeMock.mockResolvedValue([])
    fetchFundingRateHistoryMock.mockResolvedValue([])
  })

  it('archive-only range: backfill entirely inside completed months issues no CCXT calls', async () => {
    // Period start 2025-01-01, backfill oldest stored at 2025-02-01 -> range fully in Jan (completed).
    oldestFundingRateTimeMock.mockResolvedValueOnce(toClickHouseDateTime(new Date('2025-02-01T00:00:00Z')))
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('2025-01')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () =>
            Promise.resolve(
              new TextEncoder().encode(csvFor([{ ts: Date.UTC(2025, 0, 15, 8, 0, 0), rate: 0.0001 }])).buffer
            ),
        })
      }
      return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' })
    })

    const { syncFundingRates } = await import('./funding-rates-sync.js')
    await syncFundingRates('backfill')

    expect(fetchFundingRateHistoryMock).not.toHaveBeenCalled()
    expect(insertFundingRatesMock).toHaveBeenCalledTimes(1)
    const rows = insertFundingRatesMock.mock.calls[0]?.[0] as { funding_time: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.funding_time).toBe(toClickHouseDateTime(new Date(Date.UTC(2025, 0, 15, 8, 0, 0))))
  })

  it('mixed archive+CCXT range: fetches archive for completed months then falls through to CCXT for the tail', async () => {
    // "Now" is fixed via SYNC_DATA_PERIOD_END = 2025-03-15. Incremental resumes from 2025-01-20,
    // so archive covers Jan+Feb, CCXT covers the March tail.
    latestFundingRateTimeMock.mockResolvedValueOnce(toClickHouseDateTime(new Date('2025-01-20T00:00:00Z')))
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('2025-01') || url.includes('2025-02')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () =>
            Promise.resolve(
              new TextEncoder().encode(csvFor([{ ts: Date.UTC(2025, 1, 5, 8, 0, 0), rate: 0.0002 }])).buffer
            ),
        })
      }
      return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' })
    })
    // CCXT tail batch timestamp equals the post-archive startMs (2025-03-01T00:00:00Z) so the
    // backward loop's "oldest <= startMs" check terminates it after a single fetch.
    fetchFundingRateHistoryMock.mockResolvedValueOnce([
      { symbol: 'BTC/USDT:USDT', timestamp: Date.UTC(2025, 2, 1, 0, 0, 0), fundingRate: 0.0003, info: {} },
    ])

    const { syncFundingRates } = await import('./funding-rates-sync.js')
    await syncFundingRates()

    expect(fetchFundingRateHistoryMock).toHaveBeenCalledTimes(1)
    expect(insertFundingRatesMock).toHaveBeenCalledTimes(2)
    const archiveRows = insertFundingRatesMock.mock.calls[0]?.[0] as { funding_time: string }[]
    const ccxtRows = insertFundingRatesMock.mock.calls[1]?.[0] as { funding_time: string }[]
    expect(archiveRows[0]?.funding_time).toBe(toClickHouseDateTime(new Date(Date.UTC(2025, 1, 5, 8, 0, 0))))
    expect(ccxtRows[0]?.funding_time).toBe(toClickHouseDateTime(new Date(Date.UTC(2025, 2, 1, 0, 0, 0))))
  })

  it('current-month-only range: incremental resume inside the current month skips the archive entirely', async () => {
    // Resume point already inside March (the current, incomplete month) -> no archive fetch at all.
    latestFundingRateTimeMock.mockResolvedValueOnce(toClickHouseDateTime(new Date('2025-03-05T00:00:00Z')))
    // Batch timestamp equals startMs (latestStored + 1s) so the backward loop stops after one fetch.
    fetchFundingRateHistoryMock.mockResolvedValueOnce([
      { symbol: 'BTC/USDT:USDT', timestamp: Date.UTC(2025, 2, 5, 0, 0, 1), fundingRate: 0.0004, info: {} },
    ])

    const { syncFundingRates } = await import('./funding-rates-sync.js')
    await syncFundingRates()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(fetchFundingRateHistoryMock).toHaveBeenCalledTimes(1)
    expect(insertFundingRatesMock).toHaveBeenCalledTimes(1)
    const rows = insertFundingRatesMock.mock.calls[0]?.[0] as { funding_time: string }[]
    expect(rows[0]?.funding_time).toBe(toClickHouseDateTime(new Date(Date.UTC(2025, 2, 5, 0, 0, 1))))
  })
})
