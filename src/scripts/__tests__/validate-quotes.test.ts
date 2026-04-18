import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listDistinctExchangeSymbolPairsMock = vi.hoisted(() => vi.fn())
const readOrderbookDataMock = vi.hoisted(() => vi.fn())

const ohlcFinalizeMock = vi.hoisted(() => vi.fn())
const spreadFinalizeMock = vi.hoisted(() => vi.fn())
const timeContinuityFinalizeMock = vi.hoisted(() => vi.fn())
const interpolationFinalizeMock = vi.hoisted(() => vi.fn())
const priceReasonablenessFinalizeMock = vi.hoisted(() => vi.fn())
const schemaMetadataFinalizeMock = vi.hoisted(() => vi.fn())
const dayBoundaryFinalizeMock = vi.hoisted(() => vi.fn())
const perDayBreakdownFinalizeMock = vi.hoisted(() => vi.fn())
const stalePriceFinalizeMock = vi.hoisted(() => vi.fn())
const spreadDistributionFinalizeMock = vi.hoisted(() => vi.fn())
const interpolationDamageFinalizeMock = vi.hoisted(() => vi.fn())
const timestampAlignmentFinalizeMock = vi.hoisted(() => vi.fn())

const computeCompletenessMock = vi.hoisted(() => vi.fn())
const validateCrossExchangeConsistencyFromDescriptorsMock = vi.hoisted(() => vi.fn())
const printValidationReportMock = vi.hoisted(() => vi.fn())

vi.mock('../../db/queries/orderbooks.js', () => ({
  listDistinctExchangeSymbolPairs: listDistinctExchangeSymbolPairsMock,
}))

vi.mock('../../quotes/validation/index.js', () => {
  class OhlcIntegrityAccumulator {
    update(): void {
      return undefined
    }
    finalize(): unknown {
      return ohlcFinalizeMock() as unknown
    }
  }

  class SpreadValidityAccumulator {
    update(): void {
      return undefined
    }
    finalize(): unknown {
      return spreadFinalizeMock() as unknown
    }
  }

  class TimeContinuityAccumulator {
    update(): void {
      return undefined
    }
    finalize(): unknown {
      return timeContinuityFinalizeMock() as unknown
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

  class PriceReasonablenessAccumulator {
    update(): void {
      return undefined
    }
    finalize(): unknown {
      return priceReasonablenessFinalizeMock() as unknown
    }
  }

  class SchemaMetadataAccumulator {
    private firstSourceType: string | null = null
    private firstConfidenceScore: string | null = null

    update(row: { source_type: string; confidence_score: string }): void {
      this.firstSourceType ??= row.source_type
      this.firstConfidenceScore ??= row.confidence_score
    }

    getFirstSourceType(): string {
      return this.firstSourceType ?? 'unknown'
    }

    getFirstConfidenceScore(): string {
      return this.firstConfidenceScore ?? 'unknown'
    }

    finalize(): unknown {
      return schemaMetadataFinalizeMock() as unknown
    }
  }

  class DayBoundaryContinuityAccumulator {
    update(): void {
      return undefined
    }
    finalize(): unknown {
      return dayBoundaryFinalizeMock() as unknown
    }
  }

  class PerDayBreakdownAccumulator {
    update(): void {
      return undefined
    }
    finalize(): unknown {
      return perDayBreakdownFinalizeMock() as unknown
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

  class SpreadDistributionAccumulator {
    update(): void {
      return undefined
    }
    finalize(): unknown {
      return spreadDistributionFinalizeMock() as unknown
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

  class TimestampAlignmentAccumulator {
    update(): void {
      return undefined
    }
    finalize(): unknown {
      return timestampAlignmentFinalizeMock() as unknown
    }
  }

  return {
    OhlcIntegrityAccumulator,
    SpreadValidityAccumulator,
    TimeContinuityAccumulator,
    InterpolationAnalysisAccumulator,
    PriceReasonablenessAccumulator,
    SchemaMetadataAccumulator,
    DayBoundaryContinuityAccumulator,
    PerDayBreakdownAccumulator,
    StalePriceAccumulator,
    SpreadDistributionAccumulator,
    InterpolationDamageAccumulator,
    TimestampAlignmentAccumulator,
    computeCompleteness: computeCompletenessMock,
    printValidationReport: printValidationReportMock,
    readOrderbookData: readOrderbookDataMock,
    validateCrossExchangeConsistencyFromDescriptors: validateCrossExchangeConsistencyFromDescriptorsMock,
  }
})

async function loadModule() {
  vi.resetModules()
  return import('../validate-quotes.js')
}

async function* asAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    await Promise.resolve()
    yield item
  }
}

const sampleRow = {
  ts: 1_000,
  exchange: 'binance',
  symbol: 'BTCUSDT',
  bid_open: 1,
  bid_high: 1,
  bid_low: 1,
  bid_close: 1,
  ask_open: 1.1,
  ask_high: 1.1,
  ask_low: 1.1,
  ask_close: 1.1,
  source_type: 'orderbook',
  is_interpolated: false,
  confidence_score: 'high',
  missing_reason: null,
}

describe('validate-quotes script', () => {
  let originalExitCode: typeof process.exitCode
  let originalReportPath: string | undefined
  const tempDirs: string[] = []

  beforeEach(() => {
    originalExitCode = process.exitCode
    process.exitCode = undefined
    originalReportPath = process.env.QUOTES_VALIDATION_REPORT_PATH

    listDistinctExchangeSymbolPairsMock.mockReset()
    readOrderbookDataMock.mockReset()
    ohlcFinalizeMock.mockReset()
    spreadFinalizeMock.mockReset()
    timeContinuityFinalizeMock.mockReset()
    interpolationFinalizeMock.mockReset()
    priceReasonablenessFinalizeMock.mockReset()
    schemaMetadataFinalizeMock.mockReset()
    dayBoundaryFinalizeMock.mockReset()
    perDayBreakdownFinalizeMock.mockReset()
    stalePriceFinalizeMock.mockReset()
    spreadDistributionFinalizeMock.mockReset()
    interpolationDamageFinalizeMock.mockReset()
    timestampAlignmentFinalizeMock.mockReset()
    computeCompletenessMock.mockReset()
    validateCrossExchangeConsistencyFromDescriptorsMock.mockReset()
    printValidationReportMock.mockReset()

    ohlcFinalizeMock.mockReturnValue({ violationCount: 0, pass: true })
    spreadFinalizeMock.mockReturnValue({ status: 'pass', totalNegativeSpreads: 0, sourceType: 'orderbook' })
    timeContinuityFinalizeMock.mockReturnValue({ expectedCandles: 1, missingSeconds: 0, pass: true })
    interpolationFinalizeMock.mockReturnValue({
      interpolatedCount: 0,
      interpolatedPercent: 0,
      maxConsecutiveInterpolatedSeconds: 0,
      runBuckets: { '1s': 0, '2-5s': 0, '5-30s': 0, '30s-5m': 0, '>5m': 0 },
      longRuns: [],
    })
    priceReasonablenessFinalizeMock.mockReturnValue({
      status: 'pass',
      nanCount: 0,
      infinityCount: 0,
      extremeTickCount: 0,
      invalidPriceExamples: [],
      extremeTickExamples: [],
      bidCloseStats: { min: 1, max: 1, mean: 1 },
      askCloseStats: { min: 1, max: 1, mean: 1 },
    })
    schemaMetadataFinalizeMock.mockReturnValue({ pass: true })
    dayBoundaryFinalizeMock.mockReturnValue({
      dayCount: 1,
      checkedBoundaryCount: 0,
      gapAtBoundaryCount: 0,
      midnightMissingCount: 0,
      priceJumpCount: 0,
      examples: [],
      pass: true,
    })
    perDayBreakdownFinalizeMock.mockReturnValue({
      days: [],
      badDayCount: 0,
      badDays: [],
      partialDayCount: 0,
      bestDay: null,
      worstDay: null,
    })
    stalePriceFinalizeMock.mockReturnValue({
      staleSeconds: 0,
      stalePercent: 0,
      runCount: 0,
      longestRunSeconds: 0,
      runBuckets: {
        '1-10s': 0,
        '10-60s': 0,
        '1-5m': 0,
        '>5m': 0,
      },
      examples: [],
      status: 'pass',
    })
    spreadDistributionFinalizeMock.mockReturnValue({
      sampleCount: 1,
      thresholdBps: 100,
      meanBps: 0,
      medianBps: 0,
      p75Bps: 0,
      p95Bps: 0,
      p99Bps: 0,
      stddevBps: 0,
      unreasonableCount: 0,
      unreasonablePercent: 0,
      status: 'pass',
    })
    interpolationDamageFinalizeMock.mockReturnValue({
      boundaryCount: 0,
      damageScore: 0,
      highDamageCount: 0,
      maxBoundaryChangePercent: 0,
    })
    timestampAlignmentFinalizeMock.mockReturnValue({
      firstTs: 1_000,
      lastTs: 1_000,
      firstOffsetSeconds: 0,
      lastOffsetSeconds: 0,
      pass: true,
    })
    computeCompletenessMock.mockReturnValue({
      qualityScore: 100,
      expectedCandles: 1,
      actualCandles: 1,
      coveragePercent: 100,
      deductions: {
        interpolation: 0,
        gaps: 0,
        ohlc: 0,
        spread: 0,
        extremeTicks: 0,
        dayBoundary: 0,
        stalePrice: 0,
      },
    })
    validateCrossExchangeConsistencyFromDescriptorsMock.mockResolvedValue([])
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

  it('validates db datasets and writes report when configured', async () => {
    listDistinctExchangeSymbolPairsMock.mockResolvedValue([
      { exchange: 'binance', symbol: 'BTCUSDT' },
      { exchange: 'okx', symbol: 'BTCUSDT' },
    ])

    readOrderbookDataMock.mockImplementation(() => asAsyncIterable([sampleRow]))

    validateCrossExchangeConsistencyFromDescriptorsMock.mockResolvedValue([
      {
        symbol: 'BTCUSDT',
        exchanges: ['binance', 'okx'],
        overlappingSeconds: 1,
        meanDivergencePercent: 0,
        maxDivergencePercent: 0,
        divergenceAboveOnePercentCount: 0,
        examples: [],
      },
    ])

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'validate-quotes-script-'))
    tempDirs.push(tempDir)

    const reportPath = path.join(tempDir, 'report.json')
    process.env.QUOTES_VALIDATION_REPORT_PATH = reportPath

    const { runValidateQuotes } = await loadModule()
    await runValidateQuotes()

    expect(readOrderbookDataMock).toHaveBeenCalledTimes(2)
    expect(validateCrossExchangeConsistencyFromDescriptorsMock).toHaveBeenCalledTimes(1)
    expect(printValidationReportMock).toHaveBeenCalledTimes(1)
    await expect(fs.access(reportPath)).resolves.toBeUndefined()
    expect(process.exitCode).toBe(0)

    const [descriptorsBySymbol] =
      validateCrossExchangeConsistencyFromDescriptorsMock.mock.calls[0] as [Map<string, unknown[]>]
    expect([...descriptorsBySymbol.entries()]).toEqual([
      [
        'BTCUSDT',
        [
          { exchange: 'binance', symbol: 'BTCUSDT' },
          { exchange: 'okx', symbol: 'BTCUSDT' },
        ],
      ],
    ])
  })

  it('treats day-boundary gaps as critical failures', async () => {
    listDistinctExchangeSymbolPairsMock.mockResolvedValue([{ exchange: 'okx', symbol: 'APTUSDT' }])
    readOrderbookDataMock.mockImplementation(() =>
      asAsyncIterable([
        {
          ...sampleRow,
          exchange: 'okx',
          symbol: 'APTUSDT',
        },
      ])
    )

    dayBoundaryFinalizeMock.mockReturnValue({
      dayCount: 2,
      checkedBoundaryCount: 1,
      gapAtBoundaryCount: 1,
      midnightMissingCount: 0,
      priceJumpCount: 0,
      examples: [],
      pass: false,
    })

    const { runValidateQuotes } = await loadModule()
    await runValidateQuotes()

    expect(process.exitCode).toBe(1)
    expect(printValidationReportMock).toHaveBeenCalledTimes(1)

    const firstCall = printValidationReportMock.mock.calls[0] as unknown[] | undefined
    expect(firstCall).toBeDefined()

    const report = firstCall?.[0] as {
      files: { criticalFailures: string[]; status: string }[]
    }
    expect(report.files[0]?.criticalFailures).toContain('day-boundary gaps')
    expect(report.files[0]?.status).toBe('fail')
  })
})
