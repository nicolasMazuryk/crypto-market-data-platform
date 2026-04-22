import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const listDistinctExchangeSymbolPairsMock = vi.hoisted(() => vi.fn())
const queryOrderbookAggregatesMock = vi.hoisted(() => vi.fn())
const queryOrderbookPerDayStatsMock = vi.hoisted(() => vi.fn())
const queryOrderbookCrossExchangeOverlapMock = vi.hoisted(() => vi.fn())

const readOrderbookLiteDataMock = vi.hoisted(() => vi.fn())

const timeContinuityFinalizeMock = vi.hoisted(() => vi.fn())
const stalePriceFinalizeMock = vi.hoisted(() => vi.fn())
const interpolationFinalizeMock = vi.hoisted(() => vi.fn())
const interpolationDamageFinalizeMock = vi.hoisted(() => vi.fn())
const priceReasonablenessFinalizeMock = vi.hoisted(() => vi.fn())

const computeCompletenessMock = vi.hoisted(() => vi.fn())
const printValidationReportMock = vi.hoisted(() => vi.fn())

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../db/queries/orderbooks.js', () => ({
  listDistinctExchangeSymbolPairs: listDistinctExchangeSymbolPairsMock,
  queryOrderbookAggregates: queryOrderbookAggregatesMock,
  queryOrderbookPerDayStats: queryOrderbookPerDayStatsMock,
  queryOrderbookCrossExchangeOverlap: queryOrderbookCrossExchangeOverlapMock,
}))

vi.mock('../../quotes/validation/index.js', () => {
  // Inline the two date-utility functions used by buildDayBoundaryResult / buildTimestampAlignmentResult
  function dayStartMs(dateStr: string): number {
    return Date.parse(`${dateStr}T00:00:00.000Z`)
  }
  function dayEndMs(dateStr: string): number {
    return Date.parse(`${dateStr}T23:59:59.000Z`)
  }

  class TimeContinuityAccumulator {
    update(): void {
      return undefined
    }
    finalize(): unknown {
      return timeContinuityFinalizeMock() as unknown
    }
  }

  class StalePriceAccumulator {
    update(): void {
      return undefined
    }
    finalize(): unknown {
      return stalePriceFinalizeMock() as unknown
    }
  }

  class InterpolationAnalysisAccumulator {
    update(): void {
      return undefined
    }
    finalize(): unknown {
      return interpolationFinalizeMock() as unknown
    }
  }

  class InterpolationDamageAccumulator {
    update(): void {
      return undefined
    }
    finalize(): unknown {
      return interpolationDamageFinalizeMock() as unknown
    }
  }

  class PriceReasonablenessAccumulator {
    update(): void {
      return undefined
    }
    finalize(): unknown {
      return priceReasonablenessFinalizeMock() as unknown
    }
  }

  return {
    dayStartMs,
    dayEndMs,
    TimeContinuityAccumulator,
    StalePriceAccumulator,
    InterpolationAnalysisAccumulator,
    InterpolationDamageAccumulator,
    PriceReasonablenessAccumulator,
    computeCompleteness: computeCompletenessMock,
    printValidationReport: printValidationReportMock,
    readOrderbookLiteData: readOrderbookLiteDataMock,
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadModule() {
  vi.resetModules()
  return import('../validate-quotes.js')
}

async function* emptyAsyncIterable(): AsyncIterable<never> {
  // yields nothing
}

// A complete, "all-passing" aggregate row for a symbol
function makeAggregateRow(exchange: string, symbol: string) {
  const dayStr = '2025-01-01'
  // Midnight UTC and end-of-day UTC in ms
  const firstTsMs = Date.parse(`${dayStr}T00:00:00.000Z`)
  const lastTsMs = Date.parse(`${dayStr}T23:59:59.000Z`)

  return {
    exchange,
    symbol,
    row_count: '86400',
    first_ts_ms: String(firstTsMs),
    last_ts_ms: String(lastTsMs),
    expected_candles: '86400',
    ohlc_constraint_violation_count: '0',
    partial_ohlc_count: '0',
    negative_price_count: '0',
    zero_price_non_interp_count: '0',
    spread_open_violations: '0',
    spread_high_violations: '0',
    spread_low_violations: '0',
    spread_close_violations: '0',
    nan_count: '0',
    infinity_count: '0',
    interpolated_count: '0',
    spread_sample_count: '86400',
    spread_mean_bps: '10',
    spread_stddev_bps: '1',
    spread_median_bps: '10',
    spread_p75_bps: '11',
    spread_p95_bps: '12',
    spread_p99_bps: '13',
    spread_unreasonable_count_500: '0',
    spread_unreasonable_count_100: '0',
    exchange_values: [exchange],
    symbol_values: [symbol],
    source_type_values: ['orderbook'],
    confidence_score_values: ['high'],
    first_source_type: 'orderbook',
    first_confidence_score: 'high',
    confidence_mismatch_count: '0',
    bid_close_min: '1',
    bid_close_max: '1',
    bid_close_mean: '1',
    ask_close_min: '1.01',
    ask_close_max: '1.01',
    ask_close_mean: '1.01',
  }
}

// A complete, "all-passing" per-day row (full day, no gaps)
function makePerDayRow(exchange: string, symbol: string, dayStr = '2025-01-01') {
  const firstTsMs = Date.parse(`${dayStr}T00:00:00.000Z`)
  const lastTsMs = Date.parse(`${dayStr}T23:59:59.000Z`)

  return {
    exchange,
    symbol,
    day: dayStr,
    candle_count: '86400',
    interpolated_count: '0',
    first_ts_ms: String(firstTsMs),
    last_ts_ms: String(lastTsMs),
    first_bid_close: 1,
    first_ask_close: 1.01,
    last_bid_close: 1,
    last_ask_close: 1.01,
  }
}

// ---------------------------------------------------------------------------
// Default passing finalize returns
// ---------------------------------------------------------------------------

function setupPassingFinalizes() {
  timeContinuityFinalizeMock.mockReturnValue({
    firstTs: 1_000_000_000,
    lastTs: 1_000_086_399_000,
    durationMs: 86_399_000,
    expectedCandles: 86_400,
    actualCandles: 86_400,
    gapCount: 0,
    duplicateCount: 0,
    irregularStepCount: 0,
    nonMonotonicCount: 0,
    missingSeconds: 0,
    gapExamples: [],
    pass: true,
  })

  stalePriceFinalizeMock.mockReturnValue({
    staleSeconds: 0,
    stalePercent: 0,
    runCount: 0,
    longestRunSeconds: 0,
    runBuckets: { '1-10s': 0, '10-60s': 0, '1-5m': 0, '>5m': 0 },
    examples: [],
    status: 'pass',
  })

  interpolationFinalizeMock.mockReturnValue({
    interpolatedCount: 0,
    interpolatedPercent: 0,
    maxConsecutiveInterpolatedSeconds: 0,
    runBuckets: { '1s': 0, '2-5s': 0, '5-30s': 0, '30s-5m': 0, '>5m': 0 },
    longRuns: [],
  })

  interpolationDamageFinalizeMock.mockReturnValue({
    boundaryCount: 0,
    damageScore: 0,
    highDamageCount: 0,
    maxBoundaryChangePercent: 0,
  })

  priceReasonablenessFinalizeMock.mockReturnValue({
    nanCount: 0,
    infinityCount: 0,
    invalidPriceExamples: [],
    extremeTickCount: 0,
    extremeTickExamples: [],
    bidCloseStats: { min: 1, max: 1, mean: 1 },
    askCloseStats: { min: 1.01, max: 1.01, mean: 1.01 },
    status: 'pass',
  })

  computeCompletenessMock.mockReturnValue({
    expectedCandles: 86_400,
    actualCandles: 86_400,
    coveragePercent: 100,
    qualityScore: 100,
    deductions: { interpolation: 0, gaps: 0, ohlc: 0, spread: 0, extremeTicks: 0, dayBoundary: 0, stalePrice: 0 },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validate-quotes script', () => {
  let originalExitCode: typeof process.exitCode
  let originalReportPath: string | undefined
  const tempDirs: string[] = []

  beforeEach(() => {
    originalExitCode = process.exitCode
    process.exitCode = undefined
    originalReportPath = process.env.QUOTES_VALIDATION_REPORT_PATH

    listDistinctExchangeSymbolPairsMock.mockReset()
    queryOrderbookAggregatesMock.mockReset()
    queryOrderbookPerDayStatsMock.mockReset()
    queryOrderbookCrossExchangeOverlapMock.mockReset()
    readOrderbookLiteDataMock.mockReset()
    timeContinuityFinalizeMock.mockReset()
    stalePriceFinalizeMock.mockReset()
    interpolationFinalizeMock.mockReset()
    interpolationDamageFinalizeMock.mockReset()
    priceReasonablenessFinalizeMock.mockReset()
    computeCompletenessMock.mockReset()
    printValidationReportMock.mockReset()

    // Default: empty stream for lite data
    readOrderbookLiteDataMock.mockImplementation(() => emptyAsyncIterable())
    // Default: empty cross-exchange results
    queryOrderbookCrossExchangeOverlapMock.mockResolvedValue([])

    setupPassingFinalizes()
  })

  afterEach(async () => {
    if (originalExitCode === undefined) {
      process.exitCode = undefined
    } else {
      process.exitCode = originalExitCode
    }

    if (originalReportPath === undefined) {
      delete process.env.QUOTES_VALIDATION_REPORT_PATH
    } else {
      process.env.QUOTES_VALIDATION_REPORT_PATH = originalReportPath
    }

    for (const tempDir of tempDirs) {
      await fs.rm(tempDir, { recursive: true, force: true })
    }

    tempDirs.length = 0
  })

  it('sets exit code when no orderbook datasets exist', async () => {
    listDistinctExchangeSymbolPairsMock.mockResolvedValue([])

    const { runValidateQuotes } = await loadModule()
    await runValidateQuotes()

    expect(process.exitCode).toBe(1)
    expect(printValidationReportMock).not.toHaveBeenCalled()
  })

  it('validates datasets and writes report when path is configured', async () => {
    listDistinctExchangeSymbolPairsMock.mockResolvedValue([
      { exchange: 'bybit', symbol: 'BTCUSDT' },
      { exchange: 'okx', symbol: 'BTCUSDT' },
    ])

    queryOrderbookAggregatesMock.mockResolvedValue([
      makeAggregateRow('bybit', 'BTCUSDT'),
      makeAggregateRow('okx', 'BTCUSDT'),
    ])
    queryOrderbookPerDayStatsMock.mockResolvedValue([
      makePerDayRow('bybit', 'BTCUSDT'),
      makePerDayRow('okx', 'BTCUSDT'),
    ])
    queryOrderbookCrossExchangeOverlapMock.mockResolvedValue([])

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-quotes-script-'))
    tempDirs.push(tempDir)

    const reportPath = path.join(tempDir, 'report.json')
    process.env.QUOTES_VALIDATION_REPORT_PATH = reportPath

    const { runValidateQuotes } = await loadModule()
    await runValidateQuotes()

    // Lite streaming was used for each symbol
    expect(readOrderbookLiteDataMock).toHaveBeenCalledTimes(2)
    // Cross-exchange was checked for the multi-exchange symbol
    expect(queryOrderbookCrossExchangeOverlapMock).toHaveBeenCalledWith(['BTCUSDT'])
    expect(printValidationReportMock).toHaveBeenCalledTimes(1)
    await expect(fs.access(reportPath)).resolves.toBeUndefined()
    expect(process.exitCode).toBe(0)
  })

  it('treats day-boundary gaps as critical failures', async () => {
    listDistinctExchangeSymbolPairsMock.mockResolvedValue([{ exchange: 'okx', symbol: 'APTUSDT' }])

    queryOrderbookAggregatesMock.mockResolvedValue([makeAggregateRow('okx', 'APTUSDT')])

    // Two consecutive days where the second day starts 5 seconds after the first day ends (gap)
    const day1LastMs = Date.parse('2025-01-01T23:59:59.000Z')
    const day2FirstMs = Date.parse('2025-01-02T00:00:04.000Z') // 5s after day1 last → gap of 5000ms ≠ 1000ms
    queryOrderbookPerDayStatsMock.mockResolvedValue([
      { ...makePerDayRow('okx', 'APTUSDT', '2025-01-01'), last_ts_ms: String(day1LastMs) },
      { ...makePerDayRow('okx', 'APTUSDT', '2025-01-02'), first_ts_ms: String(day2FirstMs) },
    ])

    const { runValidateQuotes } = await loadModule()
    await runValidateQuotes()

    expect(process.exitCode).toBe(1)
    expect(printValidationReportMock).toHaveBeenCalledTimes(1)

    const firstCall = printValidationReportMock.mock.calls[0] as unknown[] | undefined
    const report = firstCall?.[0] as { files: { criticalFailures: string[]; status: string }[] }
    expect(report.files[0]?.criticalFailures).toContain('day-boundary gaps')
    expect(report.files[0]?.status).toBe('fail')
  })
})
