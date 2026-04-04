import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { closeClickHouseClient } from '../db/client.js'
import { listDistinctExchangeSymbolPairs } from '../db/queries/orderbooks.js'
import { VALIDATION_CONCURRENCY } from '../quotes/config.js'
import {
  DayBoundaryContinuityAccumulator,
  InterpolationAnalysisAccumulator,
  InterpolationDamageAccumulator,
  OhlcIntegrityAccumulator,
  PerDayBreakdownAccumulator,
  PriceReasonablenessAccumulator,
  SchemaMetadataAccumulator,
  SpreadDistributionAccumulator,
  SpreadValidityAccumulator,
  StalePriceAccumulator,
  TimestampAlignmentAccumulator,
  TimeContinuityAccumulator,
  computeCompleteness,
  printValidationReport,
  readOrderbookData,
  validateCrossExchangeConsistency,
  type CrossExchangeSeriesInput,
  type FileValidationResult,
  type QuoteDataDescriptor,
  type QuoteValidationReport,
  type ValidationStatus,
} from '../quotes/validation/index.js'

interface DatasetValidationOutput {
  readonly fileResult: FileValidationResult
  readonly crossExchangeSeries: CrossExchangeSeriesInput | null
}

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

async function validateDataset(descriptor: QuoteDataDescriptor): Promise<DatasetValidationOutput> {
  const stream = readOrderbookData(descriptor.exchange, descriptor.symbol)

  const ohlcAccumulator = new OhlcIntegrityAccumulator()
  const spreadAccumulator = new SpreadValidityAccumulator()
  const timeContinuityAccumulator = new TimeContinuityAccumulator()
  const interpolationAccumulator = new InterpolationAnalysisAccumulator()
  const priceReasonablenessAccumulator = new PriceReasonablenessAccumulator()
  const schemaMetadataAccumulator = new SchemaMetadataAccumulator(descriptor)
  const dayBoundaryAccumulator = new DayBoundaryContinuityAccumulator()
  const perDayBreakdownAccumulator = new PerDayBreakdownAccumulator()
  const stalePriceAccumulator = new StalePriceAccumulator()
  const spreadDistributionAccumulator = new SpreadDistributionAccumulator(descriptor.symbol)
  const interpolationDamageAccumulator = new InterpolationDamageAccumulator()
  const timestampAlignmentAccumulator = new TimestampAlignmentAccumulator()

  const crossExchangePoints: CrossExchangeSeriesInput['points'] = []
  let rowCount = 0

  for await (const row of stream) {
    rowCount += 1
    ohlcAccumulator.update(row)
    spreadAccumulator.update(row)
    timeContinuityAccumulator.update(row)
    interpolationAccumulator.update(row)
    priceReasonablenessAccumulator.update(row)
    schemaMetadataAccumulator.update(row)
    dayBoundaryAccumulator.update(row)
    perDayBreakdownAccumulator.update(row)
    stalePriceAccumulator.update(row)
    spreadDistributionAccumulator.update(row)
    interpolationDamageAccumulator.update(row)
    timestampAlignmentAccumulator.update(row)

    if (
      row.bid_close !== null &&
      row.ask_close !== null &&
      Number.isFinite(row.bid_close) &&
      Number.isFinite(row.ask_close)
    ) {
      crossExchangePoints.push({
        ts: row.ts,
        midPrice: (row.bid_close + row.ask_close) / 2,
      })
    }
  }

  const sourceType = schemaMetadataAccumulator.getFirstSourceType()
  const confidenceScore = schemaMetadataAccumulator.getFirstConfidenceScore()
  const ohlc = ohlcAccumulator.finalize()
  const spread = spreadAccumulator.finalize()
  const timeContinuity = timeContinuityAccumulator.finalize()
  const interpolation = interpolationAccumulator.finalize()
  const priceReasonableness = priceReasonablenessAccumulator.finalize()
  const schemaMetadata = schemaMetadataAccumulator.finalize()
  const dayBoundary = dayBoundaryAccumulator.finalize()
  const perDayBreakdown = perDayBreakdownAccumulator.finalize()
  const stalePrice = stalePriceAccumulator.finalize()
  const spreadDistribution = spreadDistributionAccumulator.finalize()
  const interpolationDamage = interpolationDamageAccumulator.finalize()
  const timestampAlignment = timestampAlignmentAccumulator.finalize()
  const completeness = computeCompleteness(
    rowCount,
    timeContinuity.expectedCandles,
    interpolation,
    timeContinuity,
    ohlc,
    spread,
    priceReasonableness,
    dayBoundary,
    stalePrice
  )

  const baseResult: Omit<FileValidationResult, 'criticalFailures' | 'status'> = {
    descriptor: {
      exchange: descriptor.exchange,
      symbol: descriptor.symbol,
      rowCount,
    },
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

  return {
    fileResult: {
      ...baseResult,
      criticalFailures,
      status,
    },
    crossExchangeSeries:
      crossExchangePoints.length === 0
        ? null
        : {
            exchange: descriptor.exchange,
            symbol: descriptor.symbol,
            points: crossExchangePoints,
          },
  }
}

export async function runValidateQuotes(): Promise<void> {
  const pairs = await listDistinctExchangeSymbolPairs()

  if (pairs.length === 0) {
    console.log('No orderbook datasets found in ClickHouse')
    process.exitCode = 1
    return
  }

  const workerCount = Math.max(1, Math.min(VALIDATION_CONCURRENCY, pairs.length))
  console.log(`Validating ${String(pairs.length)} dataset(s) with concurrency=${String(workerCount)}`)

  const fileResultsByIndex: (FileValidationResult | undefined)[] = Array.from({ length: pairs.length })
  const crossExchangeSeriesByIndex: (CrossExchangeSeriesInput | null | undefined)[] = Array.from({
    length: pairs.length,
  })
  let nextIndex = 0

  const runWorker = async (): Promise<void> => {
    for (;;) {
      const currentIndex = nextIndex
      nextIndex += 1

      if (currentIndex >= pairs.length) {
        return
      }

      const pair = pairs[currentIndex]
      if (!pair) {
        throw new Error(`Validation pair missing at index ${String(currentIndex)}`)
      }

      const step = `[${String(currentIndex + 1)}/${String(pairs.length)}]`
      console.log(`${step} validating ${pair.exchange}/${pair.symbol}`)

      const descriptor: QuoteDataDescriptor = {
        exchange: pair.exchange,
        symbol: pair.symbol,
      }

      const output = await validateDataset(descriptor)
      fileResultsByIndex[currentIndex] = output.fileResult
      crossExchangeSeriesByIndex[currentIndex] = output.crossExchangeSeries
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))

  const fileResults = fileResultsByIndex.map((fileResult, index) => {
    if (!fileResult) {
      throw new Error(`Validation output missing for index ${String(index)}`)
    }

    return fileResult
  })

  const crossExchangeBySymbol = new Map<string, CrossExchangeSeriesInput[]>()
  for (const series of crossExchangeSeriesByIndex) {
    if (!series) {
      continue
    }

    const existing = crossExchangeBySymbol.get(series.symbol)
    if (existing) {
      existing.push(series)
    } else {
      crossExchangeBySymbol.set(series.symbol, [series])
    }
  }

  const crossExchange = validateCrossExchangeConsistency(crossExchangeBySymbol)

  const report: QuoteValidationReport = {
    generatedAt: new Date().toISOString(),
    files: fileResults,
    crossExchange,
    summary: buildSummary(fileResults),
  }

  const reportPath = process.env.QUOTES_VALIDATION_REPORT_PATH?.trim()
  if (reportPath) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true })
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
    printValidationReport(report, reportPath)
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
