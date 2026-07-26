import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MarketRow } from '../../db/types.js'

const {
  queryFundingEventsBelowThresholdMock,
  queryFundingEventTimesBelowThresholdMock,
  listExchangesBySymbolMock,
  queryOrderbookDaySweepMock,
  queryOrderbookRowsInEnvelopeMock,
  getTaskStatusesForKeysMock,
} = vi.hoisted(() => ({
  queryFundingEventsBelowThresholdMock: vi.fn(),
  queryFundingEventTimesBelowThresholdMock: vi.fn(),
  listExchangesBySymbolMock: vi.fn(),
  queryOrderbookDaySweepMock: vi.fn(),
  queryOrderbookRowsInEnvelopeMock: vi.fn(),
  getTaskStatusesForKeysMock: vi.fn(),
}))

vi.mock('../../db/queries/fundingRates.js', () => ({
  queryFundingEventsBelowThreshold: queryFundingEventsBelowThresholdMock,
  queryFundingEventTimesBelowThreshold: queryFundingEventTimesBelowThresholdMock,
  listFundingIntervalViolations: vi.fn(() => Promise.resolve([])),
}))

vi.mock('../../db/queries/markets.js', () => ({
  listExchangesBySymbol: listExchangesBySymbolMock,
}))

vi.mock('../../db/queries/orderbooks.js', () => ({
  queryOrderbookDaySweep: queryOrderbookDaySweepMock,
  queryOrderbookRowsInEnvelope: queryOrderbookRowsInEnvelopeMock,
  listOrphanOrderbookDays: vi.fn(() => Promise.resolve([])),
  listOrderbookSymbolsUnknownToMarkets: vi.fn(() => Promise.resolve([])),
}))

vi.mock('../../db/queries/downloadTasks.js', () => ({
  getTaskStatusesForKeys: getTaskStatusesForKeysMock,
  insertDownloadTasks: vi.fn(() => Promise.resolve()),
}))

function makeMarket(overrides: Partial<MarketRow> = {}): MarketRow {
  return {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    exchange_symbol: 'BTCUSDT',
    type: 'perpetual',
    listing_date: null,
    delisting_date: null,
    is_active: true,
    ...overrides,
  }
}

describe('computeEventWindow / windowLengthSeconds', () => {
  it('builds a [T-pre, T+post+1) window', async () => {
    const { computeEventWindow, windowLengthSeconds } = await import('../audit-backtest-coverage.js')
    const t = Date.UTC(2026, 4, 1, 8, 0, 0)
    const window = computeEventWindow(t, 60, 120)
    expect(window.startMs).toBe(t - 60_000)
    expect(window.endMs).toBe(t + 121_000)
    expect(windowLengthSeconds(60, 120)).toBe(181)
  })
})

describe('isUnobtainableError', () => {
  it('detects 404 and file-not-found messages', async () => {
    const { isUnobtainableError } = await import('../audit-backtest-coverage.js')
    expect(isUnobtainableError('HTTP 404 Not Found')).toBe(true)
    expect(isUnobtainableError('File not found in archive')).toBe(true)
    expect(isUnobtainableError('connection reset')).toBe(false)
    expect(isUnobtainableError(null)).toBe(false)
  })
})

describe('classifyEvent', () => {
  it('is ok when the full window is present with no null prices', async () => {
    const { classifyEvent } = await import('../audit-backtest-coverage.js')
    expect(
      classifyEvent({ secondsPresent: 181, windowSeconds: 181, hasNullPrice: false, taskStatuses: [] })
    ).toBe('ok')
  })

  it('is missing_seconds when partially present', async () => {
    const { classifyEvent } = await import('../audit-backtest-coverage.js')
    expect(
      classifyEvent({ secondsPresent: 90, windowSeconds: 181, hasNullPrice: false, taskStatuses: [] })
    ).toBe('missing_seconds')
  })

  it('is missing_seconds when full but has a null price', async () => {
    const { classifyEvent } = await import('../audit-backtest-coverage.js')
    expect(
      classifyEvent({ secondsPresent: 181, windowSeconds: 181, hasNullPrice: true, taskStatuses: [] })
    ).toBe('missing_seconds')
  })

  it('is task_missing when zero seconds and no download_tasks row', async () => {
    const { classifyEvent } = await import('../audit-backtest-coverage.js')
    expect(
      classifyEvent({ secondsPresent: 0, windowSeconds: 181, hasNullPrice: false, taskStatuses: [undefined] })
    ).toBe('task_missing')
  })

  it('is not_yet_downloaded when zero seconds and task is pending/downloading/processing', async () => {
    const { classifyEvent } = await import('../audit-backtest-coverage.js')
    for (const status of ['pending', 'downloading', 'processing'] as const) {
      expect(
        classifyEvent({
          secondsPresent: 0,
          windowSeconds: 181,
          hasNullPrice: false,
          taskStatuses: [{ status, error_message: null }],
        })
      ).toBe('not_yet_downloaded')
    }
  })

  it('is failed_retryable when zero seconds and task failed with a non-404 error', async () => {
    const { classifyEvent } = await import('../audit-backtest-coverage.js')
    expect(
      classifyEvent({
        secondsPresent: 0,
        windowSeconds: 181,
        hasNullPrice: false,
        taskStatuses: [{ status: 'failed', error_message: 'connection reset' }],
      })
    ).toBe('failed_retryable')
  })

  it('is unobtainable when zero seconds and every failed task is a 404', async () => {
    const { classifyEvent } = await import('../audit-backtest-coverage.js')
    expect(
      classifyEvent({
        secondsPresent: 0,
        windowSeconds: 181,
        hasNullPrice: false,
        taskStatuses: [{ status: 'failed', error_message: 'HTTP 404 File not found' }],
      })
    ).toBe('unobtainable')
  })

  it('prefers not_yet_downloaded over failed when the window spans two task dates', async () => {
    const { classifyEvent } = await import('../audit-backtest-coverage.js')
    expect(
      classifyEvent({
        secondsPresent: 0,
        windowSeconds: 181,
        hasNullPrice: false,
        taskStatuses: [
          { status: 'failed', error_message: '404' },
          { status: 'pending', error_message: null },
        ],
      })
    ).toBe('not_yet_downloaded')
  })

  it('falls back to missing_seconds when zero seconds but the task is marked completed', async () => {
    const { classifyEvent } = await import('../audit-backtest-coverage.js')
    expect(
      classifyEvent({
        secondsPresent: 0,
        windowSeconds: 181,
        hasNullPrice: false,
        taskStatuses: [{ status: 'completed', error_message: null }],
      })
    ).toBe('missing_seconds')
  })
})

describe('auditFundingToOrderbook: S5 cross-exchange expansion', () => {
  beforeEach(() => {
    queryFundingEventsBelowThresholdMock.mockReset()
    queryFundingEventTimesBelowThresholdMock.mockReset()
    listExchangesBySymbolMock.mockReset()
    queryOrderbookDaySweepMock.mockReset()
    queryOrderbookRowsInEnvelopeMock.mockReset()
    getTaskStatusesForKeysMock.mockReset()
  })

  it('replicates the origin funding event to every exchange listing the symbol that day, matching task creation', async () => {
    const fundingTimeMs = Date.UTC(2026, 4, 1, 8, 0, 0)

    // Only binance had a below-threshold event; bybit is added purely via S5 expansion.
    queryFundingEventsBelowThresholdMock.mockResolvedValue([
      { exchange: 'binance', symbol: 'BTCUSDT', funding_date: '2026-05-01', is_midnight: 0 },
    ])
    queryFundingEventTimesBelowThresholdMock.mockResolvedValue([
      { exchange: 'binance', symbol: 'BTCUSDT', funding_time: '2026-05-01 08:00:00', funding_rate: -0.004 },
    ])
    listExchangesBySymbolMock.mockResolvedValue([
      makeMarket({ exchange: 'binance' }),
      makeMarket({ exchange: 'bybit' }),
    ])

    // binance's day is fully complete -> fast path, no second-level query needed.
    // bybit's day is incomplete -> falls through to the second-level check.
    queryOrderbookDaySweepMock.mockResolvedValue([
      { exchange: 'binance', symbol: 'BTCUSDT', d: '2026-05-01', rows: 86_400, interp: 0, nulls: 0 },
      { exchange: 'bybit', symbol: 'BTCUSDT', d: '2026-05-01', rows: 100, interp: 0, nulls: 0 },
    ])

    queryOrderbookRowsInEnvelopeMock.mockImplementation((exchange: string) => {
      if (exchange === 'bybit') {
        // Only 50 of the 181 required seconds are present.
        return Promise.resolve(
          Array.from({ length: 50 }, (_, i) => ({
            ts_ms: fundingTimeMs - 60_000 + i * 1000,
            bid_close: 100,
            ask_close: 101,
            is_interpolated: false,
          }))
        )
      }
      return Promise.resolve([])
    })
    getTaskStatusesForKeysMock.mockResolvedValue(new Map())

    const { auditFundingToOrderbook } = await import('../audit-backtest-coverage.js')
    const results = await auditFundingToOrderbook({
      dateRangeStart: '2026-05-01',
      dateRangeEnd: '2026-05-01',
      threshold: -0.003,
      excludedExchanges: ['mexc'],
      reportPath: '/tmp/unused.json',
      fix: false,
      preFundingSeconds: 60,
      postFundingSeconds: 120,
    })

    expect(results).toHaveLength(2)
    const binanceResult = results.find(r => r.exchange === 'binance')
    const bybitResult = results.find(r => r.exchange === 'bybit')

    expect(binanceResult?.verdict).toBe('ok')
    expect(bybitResult?.verdict).toBe('missing_seconds')
    expect(bybitResult?.secondsPresent).toBe(50)

    // The second-level query and status lookup should only run for bybit (the incomplete day).
    expect(queryOrderbookRowsInEnvelopeMock).toHaveBeenCalledTimes(1)
    expect(queryOrderbookRowsInEnvelopeMock).toHaveBeenCalledWith('bybit', 'BTCUSDT', expect.any(Number), expect.any(Number))
  })

  it('excludes exchanges in FUNDING_DOWNLOAD_TASKS_EXCLUDED_EXCHANGES from S5 expansion', async () => {
    queryFundingEventsBelowThresholdMock.mockResolvedValue([
      { exchange: 'binance', symbol: 'BTCUSDT', funding_date: '2026-05-01', is_midnight: 0 },
    ])
    queryFundingEventTimesBelowThresholdMock.mockResolvedValue([
      { exchange: 'binance', symbol: 'BTCUSDT', funding_time: '2026-05-01 08:00:00', funding_rate: -0.004 },
    ])
    listExchangesBySymbolMock.mockResolvedValue([
      makeMarket({ exchange: 'binance' }),
      makeMarket({ exchange: 'mexc' }),
    ])
    queryOrderbookDaySweepMock.mockResolvedValue([
      { exchange: 'binance', symbol: 'BTCUSDT', d: '2026-05-01', rows: 86_400, interp: 0, nulls: 0 },
    ])
    queryOrderbookRowsInEnvelopeMock.mockResolvedValue([])
    getTaskStatusesForKeysMock.mockResolvedValue(new Map())

    const { auditFundingToOrderbook } = await import('../audit-backtest-coverage.js')
    const results = await auditFundingToOrderbook({
      dateRangeStart: '2026-05-01',
      dateRangeEnd: '2026-05-01',
      threshold: -0.003,
      excludedExchanges: ['mexc'],
      reportPath: '/tmp/unused.json',
      fix: false,
      preFundingSeconds: 60,
      postFundingSeconds: 120,
    })

    expect(results).toHaveLength(1)
    expect(results[0]?.exchange).toBe('binance')
  })
})
