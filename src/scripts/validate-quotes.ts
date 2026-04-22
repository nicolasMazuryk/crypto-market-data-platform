import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { closeClickHouseClient } from '../db/client.js'
import {
  listDistinctExchangeSymbolPairs,
  queryOrderbookAggregates,
  queryOrderbookCrossExchangeOverlap,
  queryOrderbookPerDayStats,
} from '../db/queries/orderbooks.js'
import type {
  OrderbookAggregateRow,
  OrderbookCrossExchangeRow,
  OrderbookPerDayRow,
} from '../db/queries/orderbooks.js'
import { VALIDATION_CONCURRENCY } from '../quotes/config.js'
import {
  InterpolationAnalysisAccumulator,
  InterpolationDamageAccumulator,
  StalePriceAccumulator,
  TimeContinuityAccumulator,
  PriceReasonablenessAccumulator,
  computeCompleteness,
  dayEndMs,
  dayStartMs,
  printValidationReport,
  readOrderbookLiteData,
  type FileValidationResult,
  type QuoteDataDescriptor,
  type QuoteValidationReport,
  type ValidationStatus,
} from '../quotes/validation/index.js'
import type {
  CrossExchangeResult,
  DayBoundaryContinuityResult,
  DayQualityEntry,
  InterpolationAnalysisResult,
  InterpolationDamageResult,
  OhlcIntegrityResult,
  PerDayBreakdownResult,
  PriceReasonablenessResult,
  SchemaMetadataResult,
  SpreadDistributionResult,
  SpreadValidityResult,
  StalePriceResult,
  TimeContinuityResult,
  TimestampAlignmentResult,
} from '../quotes/validation/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  return Number(value)
}

function toNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isNaN(n) ? null : n
}

function toSorted(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b))
}

function buildArchivedReportPath(reportPath: string, generatedAt: string): string {
  const parsed = path.parse(reportPath)
  const extension = parsed.ext.length > 0 ? parsed.ext : '.json'
  const safeTimestamp = generatedAt.replace(/[:.]/g, '-')
  return path.join(parsed.dir, `${parsed.name}-${safeTimestamp}${extension}`)
}

// ---------------------------------------------------------------------------
// Build accumulator results from SQL aggregate row
// ---------------------------------------------------------------------------

function buildOhlcResult(agg: OrderbookAggregateRow): OhlcIntegrityResult {
  const constraintViolationCount = toNumber(agg.ohlc_constraint_violation_count)
  const partialOhlcCount = toNumber(agg.partial_ohlc_count)
  const negativePriceCount = toNumber(agg.negative_price_count)
  const zeroPriceOnNonInterpolatedCount = toNumber(agg.zero_price_non_interp_count)
  const violationCount =
    constraintViolationCount + partialOhlcCount + negativePriceCount + zeroPriceOnNonInterpolatedCount

  return {
    violationCount,
    partialOhlcCount,
    negativePriceCount,
    zeroPriceOnNonInterpolatedCount,
    constraintViolationCount,
    examples: [],
    pass: violationCount === 0,
  }
}

const EXPECTED_SOURCE_TYPE_BY_EXCHANGE: Record<string, 'orderbook' | 'trades'> = {
  binance: 'trades',
  bybit: 'orderbook',
  okx: 'orderbook',
  gateio: 'orderbook',
  bitget: 'orderbook',
  kucoin: 'orderbook',
}

function buildSpreadResult(agg: OrderbookAggregateRow): SpreadValidityResult {
  const openViolations = toNumber(agg.spread_open_violations)
  const highViolations = toNumber(agg.spread_high_violations)
  const lowViolations = toNumber(agg.spread_low_violations)
  const closeViolations = toNumber(agg.spread_close_violations)
  const totalNegativeSpreads = openViolations + highViolations + lowViolations + closeViolations
  const sourceType = agg.first_source_type || 'unknown'

  let status: ValidationStatus = 'pass'
  if (totalNegativeSpreads > 0) {
    status = sourceType === 'trades' ? 'warn' : 'fail'
  }

  return {
    sourceType,
    totalNegativeSpreads,
    negativeSpreadCounts: {
      open: openViolations,
      high: highViolations,
      low: lowViolations,
      close: closeViolations,
    },
    worstNegativeSpread: null,
    examples: [],
    status,
  }
}

function buildSchemaMetadataResult(
  agg: OrderbookAggregateRow,
  descriptor: QuoteDataDescriptor
): SchemaMetadataResult {
  const exchangeValues = toSorted(agg.exchange_values)
  const symbolValues = toSorted(agg.symbol_values)
  const sourceTypeValues = toSorted(agg.source_type_values)
  const confidenceScoreValues = toSorted(agg.confidence_score_values)

  const exchangeConsistent = exchangeValues.length === 1
  const symbolConsistent = symbolValues.length === 1
  const sourceTypeConsistent = sourceTypeValues.length === 1
  const confidenceScoreConsistent = confidenceScoreValues.length === 1

  const exchangeMatchesDescriptor = exchangeConsistent && exchangeValues[0] === descriptor.exchange
  const symbolMatchesDescriptor = symbolConsistent && symbolValues[0] === descriptor.symbol

  const expectedSourceType = EXPECTED_SOURCE_TYPE_BY_EXCHANGE[descriptor.exchange]
  const sourceTypeMatchesExpectedForExchange =
    expectedSourceType === undefined
      ? true
      : sourceTypeConsistent && sourceTypeValues[0] === expectedSourceType

  const confidenceMatchesSourceType = toNumber(agg.confidence_mismatch_count) === 0

  const pass =
    exchangeConsistent &&
    symbolConsistent &&
    sourceTypeConsistent &&
    confidenceScoreConsistent &&
    exchangeMatchesDescriptor &&
    symbolMatchesDescriptor &&
    sourceTypeMatchesExpectedForExchange &&
    confidenceMatchesSourceType

  return {
    missingColumns: [],
    unexpectedColumns: [],
    exchangeValues,
    symbolValues,
    sourceTypeValues,
    confidenceScoreValues,
    exchangeConsistent,
    symbolConsistent,
    sourceTypeConsistent,
    confidenceScoreConsistent,
    exchangeMatchesDescriptor,
    symbolMatchesDescriptor,
    sourceTypeMatchesExpectedForExchange,
    confidenceMatchesSourceType,
    pass,
  }
}

function buildSpreadDistributionResult(
  agg: OrderbookAggregateRow,
  symbol: string
): SpreadDistributionResult {
  const MAJOR_BASE_ASSETS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP']
  const isMajor = MAJOR_BASE_ASSETS.some(asset => symbol.toUpperCase().startsWith(asset))
  const thresholdBps = isMajor ? 100 : 500

  const sampleCount = toNumber(agg.spread_sample_count)
  const unreasonableCount = toNumber(isMajor ? agg.spread_unreasonable_count_100 : agg.spread_unreasonable_count_500)
  const unreasonablePercent = sampleCount === 0 ? 0 : (unreasonableCount / sampleCount) * 100

  let status: ValidationStatus = 'pass'
  if (unreasonablePercent > 5) {
    status = 'fail'
  } else if (unreasonablePercent > 1) {
    status = 'warn'
  }

  return {
    sampleCount,
    thresholdBps,
    meanBps: toNumberOrNull(agg.spread_mean_bps),
    medianBps: toNumberOrNull(agg.spread_median_bps),
    p75Bps: toNumberOrNull(agg.spread_p75_bps),
    p95Bps: toNumberOrNull(agg.spread_p95_bps),
    p99Bps: toNumberOrNull(agg.spread_p99_bps),
    stddevBps: toNumberOrNull(agg.spread_stddev_bps),
    unreasonableCount,
    unreasonablePercent,
    status,
  }
}

function buildTimestampAlignmentResult(agg: OrderbookAggregateRow): TimestampAlignmentResult {
  const firstTs = toNumber(agg.first_ts_ms)
  const lastTs = toNumber(agg.last_ts_ms)

  if (firstTs === 0 && lastTs === 0) {
    return { firstTs: null, lastTs: null, firstOffsetSeconds: null, lastOffsetSeconds: null, pass: false }
  }

  const firstDay = new Date(firstTs).toISOString().slice(0, 10)
  const lastDay = new Date(lastTs).toISOString().slice(0, 10)
  const firstOffsetSeconds = Math.round((firstTs - dayStartMs(firstDay)) / 1000)
  const lastOffsetSeconds = Math.round((dayEndMs(lastDay) - lastTs) / 1000)

  return {
    firstTs,
    lastTs,
    firstOffsetSeconds,
    lastOffsetSeconds,
    pass: firstOffsetSeconds === 0 && lastOffsetSeconds === 0,
  }
}

// ---------------------------------------------------------------------------
// Build PerDayBreakdown + DayBoundary from per-day SQL rows
// ---------------------------------------------------------------------------

const FULL_DAY_EXPECTED_CANDLES = 24 * 60 * 60
const ONE_SECOND_MS = 1000

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function perDayQualityScore(
  coveragePercent: number,
  interpolationPercent: number,
  gapCount: number,
  missingSeconds: number
): number {
  const coverageDeduction = Math.min(60, Math.max(0, 100 - coveragePercent) * 2)
  const interpolationDeduction = Math.min(30, interpolationPercent * 0.5)
  const continuityDeduction = Math.min(20, gapCount * 2 + missingSeconds * 0.05)
  return Math.round(clamp(100 - coverageDeduction - interpolationDeduction - continuityDeduction, 0, 100))
}

function buildPerDayBreakdown(dayRows: OrderbookPerDayRow[]): PerDayBreakdownResult {
  if (dayRows.length === 0) {
    return { days: [], badDayCount: 0, badDays: [], partialDayCount: 0, bestDay: null, worstDay: null }
  }

  const days: DayQualityEntry[] = dayRows.map((row, index) => {
    const firstTsMs = toNumber(row.first_ts_ms)
    const lastTsMs = toNumber(row.last_ts_ms)
    const candleCount = toNumber(row.candle_count)
    const interpolatedCount = toNumber(row.interpolated_count)
    const interpolationPercent = candleCount === 0 ? 0 : (interpolatedCount / candleCount) * 100

    const dayStart = dayStartMs(row.day)
    const dayEnd = dayEndMs(row.day)
    const isFirstOrLast = index === 0 || index === dayRows.length - 1
    const isFullDay = firstTsMs === dayStart && lastTsMs === dayEnd
    const partialDay = !isFullDay && isFirstOrLast

    let expectedCandles: number
    if (partialDay) {
      expectedCandles = Math.max(candleCount, Math.floor((lastTsMs - firstTsMs) / ONE_SECOND_MS) + 1)
    } else {
      expectedCandles = FULL_DAY_EXPECTED_CANDLES
    }

    const coveragePercent = expectedCandles === 0 ? 0 : (candleCount / expectedCandles) * 100
    // gapCount / missingSeconds per day are not available from the aggregate query;
    // they are informational only and do not affect badDayCount determination.
    const qualityScore = perDayQualityScore(coveragePercent, interpolationPercent, 0, 0)

    return {
      date: row.day,
      candleCount,
      expectedCandles,
      coveragePercent,
      interpolationPercent,
      gapCount: 0,
      missingSeconds: 0,
      qualityScore,
      partialDay,
    }
  })

  const nonPartialDays = days.filter(d => !d.partialDay)
  const averageInterpolationPercent =
    nonPartialDays.length === 0
      ? 0
      : nonPartialDays.reduce((sum, d) => sum + d.interpolationPercent, 0) / nonPartialDays.length

  const badDays = nonPartialDays
    .filter(d => d.coveragePercent < 99 || d.interpolationPercent > averageInterpolationPercent * 1.5)
    .map(d => d.date)

  let bestDay: DayQualityEntry | null = null
  let worstDay: DayQualityEntry | null = null
  for (const day of days) {
    if (bestDay === null || day.qualityScore > bestDay.qualityScore) bestDay = day
    if (worstDay === null || day.qualityScore < worstDay.qualityScore) worstDay = day
  }

  return {
    days,
    badDayCount: badDays.length,
    badDays,
    partialDayCount: days.filter(d => d.partialDay).length,
    bestDay,
    worstDay,
  }
}

function toMidPrice(bidClose: number | null, askClose: number | null): number | null {
  if (bidClose === null || askClose === null || !Number.isFinite(bidClose) || !Number.isFinite(askClose)) {
    return null
  }
  return (bidClose + askClose) / 2
}

function buildDayBoundaryResult(dayRows: OrderbookPerDayRow[]): DayBoundaryContinuityResult {
  const PRICE_JUMP_THRESHOLD_PERCENT = 0.25

  if (dayRows.length === 0) {
    return { dayCount: 0, checkedBoundaryCount: 0, gapAtBoundaryCount: 0, midnightMissingCount: 0, priceJumpCount: 0, examples: [], pass: true }
  }

  let checkedBoundaryCount = 0
  let gapAtBoundaryCount = 0
  let midnightMissingCount = 0
  let priceJumpCount = 0
  const examples: DayBoundaryContinuityResult['examples'] = []

  for (let i = 1; i < dayRows.length; i++) {
    const prev = dayRows[i - 1]
    const curr = dayRows[i]
    if (!prev || !curr) continue

    const prevLastTs = toNumber(prev.last_ts_ms)
    const currFirstTs = toNumber(curr.first_ts_ms)
    const deltaMs = currFirstTs - prevLastTs

    checkedBoundaryCount += 1
    const gapDetected = deltaMs !== ONE_SECOND_MS
    if (gapDetected) gapAtBoundaryCount += 1

    const currDayStart = dayStartMs(curr.day)
    const midnightMissing = currFirstTs !== currDayStart
    if (midnightMissing) midnightMissingCount += 1

    const prevMid = toMidPrice(toNumberOrNull(prev.last_bid_close), toNumberOrNull(prev.last_ask_close))
    const currMid = toMidPrice(toNumberOrNull(curr.first_bid_close), toNumberOrNull(curr.first_ask_close))
    let priceJumpPercent: number | null = null

    if (prevMid !== null && currMid !== null && prevMid !== 0) {
      priceJumpPercent = Math.abs(((currMid - prevMid) / prevMid) * 100)
      if (priceJumpPercent > PRICE_JUMP_THRESHOLD_PERCENT) priceJumpCount += 1
    }

    if (
      (gapDetected || midnightMissing || (priceJumpPercent !== null && priceJumpPercent > PRICE_JUMP_THRESHOLD_PERCENT)) &&
      examples.length < 20
    ) {
      examples.push({
        previousDay: prev.day,
        nextDay: curr.day,
        previousTs: prevLastTs,
        nextTs: currFirstTs,
        deltaMs,
        missingSeconds: deltaMs > ONE_SECOND_MS ? Math.floor(deltaMs / ONE_SECOND_MS) - 1 : 0,
        priceJumpPercent,
        midnightMissing,
      })
    }
  }

  return {
    dayCount: dayRows.length,
    checkedBoundaryCount,
    gapAtBoundaryCount,
    midnightMissingCount,
    priceJumpCount,
    examples,
    pass: gapAtBoundaryCount === 0 && midnightMissingCount === 0 && priceJumpCount === 0,
  }
}

// ---------------------------------------------------------------------------
// Build PriceReasonablenessResult merging SQL + streaming extreme tick count
// ---------------------------------------------------------------------------

function buildPriceReasonablenessResult(
  agg: OrderbookAggregateRow,
  extremeTickCount: number,
  extremeTickExamples: PriceReasonablenessResult['extremeTickExamples']
): PriceReasonablenessResult {
  const nanCount = toNumber(agg.nan_count)
  const infinityCount = toNumber(agg.infinity_count)

  let status: ValidationStatus = 'pass'
  if (nanCount > 0 || infinityCount > 0) {
    status = 'fail'
  } else if (extremeTickCount > 0) {
    status = 'warn'
  }

  const bidCloseMin = toNumberOrNull(agg.bid_close_min)
  const bidCloseMax = toNumberOrNull(agg.bid_close_max)
  const bidCloseMean = toNumberOrNull(agg.bid_close_mean)
  const askCloseMin = toNumberOrNull(agg.ask_close_min)
  const askCloseMax = toNumberOrNull(agg.ask_close_max)
  const askCloseMean = toNumberOrNull(agg.ask_close_mean)

  return {
    nanCount,
    infinityCount,
    invalidPriceExamples: [],
    extremeTickCount,
    extremeTickExamples,
    bidCloseStats: { min: bidCloseMin, max: bidCloseMax, mean: bidCloseMean },
    askCloseStats: { min: askCloseMin, max: askCloseMax, mean: askCloseMean },
    status,
  }
}

// ---------------------------------------------------------------------------
// Critical failures + status derivation (unchanged logic)
// ---------------------------------------------------------------------------

function computeCriticalFailures(file: Omit<FileValidationResult, 'criticalFailures' | 'status'>): string[] {
  const criticalFailures: string[] = []

  if (file.ohlc.violationCount > 0) {
    criticalFailures.push('OHLC violations')
  }

  if (file.priceReasonableness.nanCount > 0 || file.priceReasonableness.infinityCount > 0) {
    criticalFailures.push('NaN/Inf prices')
  }

  if (file.timeContinuity.missingSeconds > 0) {
    criticalFailures.push('missing seconds')
  }

  if (file.completeness.qualityScore < 50) {
    criticalFailures.push('quality score below 50')
  }

  if (file.dayBoundary.gapAtBoundaryCount > 0) {
    criticalFailures.push('day-boundary gaps')
  }

  if (file.stalePrice.status === 'fail') {
    criticalFailures.push('stale-price runs >5m')
  }

  return criticalFailures
}

function deriveFileStatus(
  file: Omit<FileValidationResult, 'criticalFailures' | 'status'>,
  criticalFailures: string[]
): ValidationStatus {
  if (
    criticalFailures.length > 0 ||
    !file.ohlc.pass ||
    !file.timeContinuity.pass ||
    !file.schemaMetadata.pass ||
    !file.dayBoundary.pass ||
    file.spread.status === 'fail' ||
    file.priceReasonableness.status === 'fail' ||
    file.stalePrice.status === 'fail' ||
    file.spreadDistribution.status === 'fail'
  ) {
    return 'fail'
  }

  if (
    file.spread.status === 'warn' ||
    file.priceReasonableness.status === 'warn' ||
    file.interpolation.longRuns.length > 0 ||
    file.stalePrice.status === 'warn' ||
    file.spreadDistribution.status === 'warn' ||
    !file.timestampAlignment.pass ||
    file.perDayBreakdown.badDayCount > 0 ||
    file.interpolationDamage.highDamageCount > 0
  ) {
    return 'warn'
  }

  return 'pass'
}

// ---------------------------------------------------------------------------
// Consecutive-row accumulators (lightweight stream: 4 columns)
// ---------------------------------------------------------------------------

interface ConsecutiveResult {
  timeContinuity: TimeContinuityResult
  stalePrice: StalePriceResult
  interpolation: InterpolationAnalysisResult
  interpolationDamage: InterpolationDamageResult
  extremeTickCount: number
  extremeTickExamples: PriceReasonablenessResult['extremeTickExamples']
}

async function runConsecutiveAccumulators(
  exchange: string,
  symbol: string
): Promise<ConsecutiveResult> {
  const stream = readOrderbookLiteData(exchange, symbol)

  const timeContinuityAccumulator = new TimeContinuityAccumulator()
  const stalePriceAccumulator = new StalePriceAccumulator()
  const interpolationAccumulator = new InterpolationAnalysisAccumulator()
  const interpolationDamageAccumulator = new InterpolationDamageAccumulator()
  const priceReasonablenessAccumulator = new PriceReasonablenessAccumulator()

  for await (const row of stream) {
    timeContinuityAccumulator.update(row)
    stalePriceAccumulator.update(row)
    interpolationAccumulator.update(row)
    interpolationDamageAccumulator.update(row)
    priceReasonablenessAccumulator.update(row)
  }

  const priceResult = priceReasonablenessAccumulator.finalize()

  return {
    timeContinuity: timeContinuityAccumulator.finalize(),
    stalePrice: stalePriceAccumulator.finalize(),
    interpolation: interpolationAccumulator.finalize(),
    interpolationDamage: interpolationDamageAccumulator.finalize(),
    extremeTickCount: priceResult.extremeTickCount,
    extremeTickExamples: priceResult.extremeTickExamples,
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function buildSummary(files: FileValidationResult[]): QuoteValidationReport['summary'] {
  let passedFiles = 0
  let warnedFiles = 0
  let failedFiles = 0
  let criticalFailureCount = 0
  let qualityScoreTotal = 0
  let minQualityScore = 100

  for (const file of files) {
    if (file.status === 'pass') {
      passedFiles += 1
    } else if (file.status === 'warn') {
      warnedFiles += 1
    } else {
      failedFiles += 1
    }

    criticalFailureCount += file.criticalFailures.length
    qualityScoreTotal += file.completeness.qualityScore
    minQualityScore = Math.min(minQualityScore, file.completeness.qualityScore)
  }

  return {
    fileCount: files.length,
    passedFiles,
    warnedFiles,
    failedFiles,
    criticalFailureCount,
    averageQualityScore: files.length === 0 ? 0 : qualityScoreTotal / files.length,
    minQualityScore: files.length === 0 ? 0 : minQualityScore,
  }
}

// ---------------------------------------------------------------------------
// Cross-exchange from SQL rows
// ---------------------------------------------------------------------------

function computeCrossExchangeFromRows(rows: OrderbookCrossExchangeRow[]): CrossExchangeResult[] {
  const EXAMPLE_LIMIT = 10

  const bySymbol = new Map<
    string,
    { exchanges: Set<string>; stats: { divergenceSum: number; maxDivergence: number; overlapping: number; aboveOne: number; examples: CrossExchangeResult['examples'] } }
  >()

  for (const row of rows) {
    const tsMs = toNumber(row.ts_ms)
    const exchanges = row.exchanges
    const midPrices = row.mid_prices.map(Number)

    if (exchanges.length < 2) continue

    let entry = bySymbol.get(row.symbol)
    if (!entry) {
      entry = { exchanges: new Set(), stats: { divergenceSum: 0, maxDivergence: 0, overlapping: 0, aboveOne: 0, examples: [] } }
      bySymbol.set(row.symbol, entry)
    }

    for (const ex of exchanges) entry.exchanges.add(ex)

    let lowIdx = 0
    let highIdx = 0
    for (let i = 1; i < midPrices.length; i++) {
      const p = midPrices[i]
      const low = midPrices[lowIdx]
      const high = midPrices[highIdx]
      if (p !== undefined && low !== undefined && p < low) lowIdx = i
      if (p !== undefined && high !== undefined && p > high) highIdx = i
    }

    const lowMid = midPrices[lowIdx] ?? 0
    const highMid = midPrices[highIdx] ?? 0
    const midpoint = (lowMid + highMid) / 2
    const divergence = midpoint === 0 ? 0 : ((highMid - lowMid) / midpoint) * 100

    entry.stats.overlapping += 1
    entry.stats.divergenceSum += divergence
    entry.stats.maxDivergence = Math.max(entry.stats.maxDivergence, divergence)

    if (divergence > 1) {
      entry.stats.aboveOne += 1
      if (entry.stats.examples.length < EXAMPLE_LIMIT) {
        entry.stats.examples.push({
          ts: tsMs,
          divergencePercent: divergence,
          lowExchange: exchanges[lowIdx] ?? '',
          highExchange: exchanges[highIdx] ?? '',
          lowMidPrice: lowMid,
          highMidPrice: highMid,
        })
      }
    }
  }

  return [...bySymbol.entries()]
    .map(([symbol, { exchanges, stats }]) => ({
      symbol,
      exchanges: [...exchanges].sort((a, b) => a.localeCompare(b)),
      overlappingSeconds: stats.overlapping,
      meanDivergencePercent: stats.overlapping === 0 ? 0 : stats.divergenceSum / stats.overlapping,
      maxDivergencePercent: stats.maxDivergence,
      divergenceAboveOnePercentCount: stats.aboveOne,
      examples: stats.examples,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runValidateQuotes(): Promise<void> {
  const pairs = await listDistinctExchangeSymbolPairs()

  if (pairs.length === 0) {
    console.log('No orderbook datasets found in ClickHouse')
    process.exitCode = 1
    return
  }

  console.log(`Found ${String(pairs.length)} dataset(s). Running batch SQL aggregation…`)

  // Run batch SQL queries (covers 10 of 12 accumulators) — no per-symbol streaming
  const [aggregateRows, perDayRows] = await Promise.all([
    queryOrderbookAggregates(),
    queryOrderbookPerDayStats(),
  ])

  // Index by exchange/symbol
  const aggregateMap = new Map<string, OrderbookAggregateRow>()
  for (const row of aggregateRows) {
    aggregateMap.set(`${row.exchange}/${row.symbol}`, row)
  }

  const perDayMap = new Map<string, OrderbookPerDayRow[]>()
  for (const row of perDayRows) {
    const key = `${row.exchange}/${row.symbol}`
    const existing = perDayMap.get(key)
    if (existing) {
      existing.push(row)
    } else {
      perDayMap.set(key, [row])
    }
  }

  // Lightweight concurrent streaming: 4 columns only (ts, bid_close, ask_close, is_interpolated)
  // for the 4 accumulators that require consecutive-row state
  const workerCount = Math.max(1, Math.min(VALIDATION_CONCURRENCY, pairs.length))
  console.log(
    `SQL aggregation complete. Running consecutive-row checks with concurrency=${String(workerCount)}…`
  )

  const consecutiveMap = new Map<string, ConsecutiveResult>()
  let nextIndex = 0

  const runWorker = async (): Promise<void> => {
    for (;;) {
      const currentIndex = nextIndex
      nextIndex += 1

      if (currentIndex >= pairs.length) return

      const pair = pairs[currentIndex]
      if (!pair) throw new Error(`Pair missing at index ${String(currentIndex)}`)

      const step = `[${String(currentIndex + 1)}/${String(pairs.length)}]`
      console.log(`${step} validating ${pair.exchange}/${pair.symbol}`)

      const result = await runConsecutiveAccumulators(pair.exchange, pair.symbol)
      consecutiveMap.set(`${pair.exchange}/${pair.symbol}`, result)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))

  // Assemble FileValidationResult for each pair
  const fileResults: FileValidationResult[] = pairs.map(pair => {
    const key = `${pair.exchange}/${pair.symbol}`
    const agg = aggregateMap.get(key)
    const dayRows = perDayMap.get(key) ?? []
    const consecutive = consecutiveMap.get(key)

    if (!agg || !consecutive) {
      throw new Error(`Missing aggregate or consecutive data for ${key}`)
    }

    const descriptor: QuoteDataDescriptor = { exchange: pair.exchange, symbol: pair.symbol }
    const rowCount = toNumber(agg.row_count)
    const sourceType = agg.first_source_type || 'unknown'
    const confidenceScore = agg.first_confidence_score || 'unknown'

    const ohlc = buildOhlcResult(agg)
    const spread = buildSpreadResult(agg)
    const timeContinuity = consecutive.timeContinuity
    const interpolation = consecutive.interpolation
    const priceReasonableness = buildPriceReasonablenessResult(
      agg,
      consecutive.extremeTickCount,
      consecutive.extremeTickExamples
    )
    const schemaMetadata = buildSchemaMetadataResult(agg, descriptor)
    const dayBoundary = buildDayBoundaryResult(dayRows)
    const perDayBreakdown = buildPerDayBreakdown(dayRows)
    const stalePrice = consecutive.stalePrice
    const spreadDistribution = buildSpreadDistributionResult(agg, pair.symbol)
    const interpolationDamage = consecutive.interpolationDamage
    const timestampAlignment = buildTimestampAlignmentResult(agg)

    const expectedCandles = toNumber(agg.expected_candles)
    const completeness = computeCompleteness(
      rowCount,
      expectedCandles,
      interpolation,
      timeContinuity,
      ohlc,
      spread,
      priceReasonableness,
      dayBoundary,
      stalePrice
    )

    const baseResult: Omit<FileValidationResult, 'criticalFailures' | 'status'> = {
      descriptor: { exchange: pair.exchange, symbol: pair.symbol, rowCount },
      rowCount,
      sourceType,
      confidenceScore,
      ohlc,
      spread,
      timeContinuity,
      interpolation,
      priceReasonableness,
      schemaMetadata,
      dayBoundary,
      perDayBreakdown,
      stalePrice,
      spreadDistribution,
      interpolationDamage,
      timestampAlignment,
      completeness,
    }

    const criticalFailures = computeCriticalFailures(baseResult)
    const status = deriveFileStatus(baseResult, criticalFailures)

    return { ...baseResult, criticalFailures, status }
  })

  // Cross-exchange validation via SQL (no second streaming pass)
  const symbolCountMap = new Map<string, number>()
  for (const pair of pairs) {
    symbolCountMap.set(pair.symbol, (symbolCountMap.get(pair.symbol) ?? 0) + 1)
  }
  const multiExchangeSymbols = [...symbolCountMap.entries()]
    .filter(([, count]) => count >= 2)
    .map(([symbol]) => symbol)

  console.log(`Running cross-exchange validation for ${String(multiExchangeSymbols.length)} symbol(s)…`)
  const crossExchangeRows = await queryOrderbookCrossExchangeOverlap(multiExchangeSymbols)
  const crossExchange = computeCrossExchangeFromRows(crossExchangeRows)

  const report: QuoteValidationReport = {
    generatedAt: new Date().toISOString(),
    files: fileResults,
    crossExchange,
    summary: buildSummary(fileResults),
  }

  const reportPath = process.env.QUOTES_VALIDATION_REPORT_PATH?.trim()
  if (reportPath) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true })
    const reportJson = JSON.stringify(report, null, 2)
    const archivePath = buildArchivedReportPath(reportPath, report.generatedAt)

    await fs.writeFile(reportPath, reportJson)
    await fs.writeFile(archivePath, reportJson)
    printValidationReport(report, reportPath)
    console.log(`Archived report written to ${archivePath}`)
  } else {
    printValidationReport(report, '(stdout)')
  }

  const hasCriticalFailure = report.files.some(file => file.criticalFailures.length > 0)
  process.exitCode = hasCriticalFailure ? 1 : 0
}

const entrypoint = process.argv[1]
const isMain = entrypoint ? import.meta.url === pathToFileURL(entrypoint).href : false

if (isMain) {
  runValidateQuotes()
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      await closeClickHouseClient()
    })
}
