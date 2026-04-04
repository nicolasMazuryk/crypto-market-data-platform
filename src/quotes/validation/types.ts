export const REQUIRED_QUOTE_COLUMNS = [
  'ts',
  'exchange',
  'symbol',
  'bid_open',
  'bid_high',
  'bid_low',
  'bid_close',
  'ask_open',
  'ask_high',
  'ask_low',
  'ask_close',
  'source_type',
  'is_interpolated',
  'confidence_score',
  'missing_reason',
] as const

export const PRICE_FIELDS = [
  'bid_open',
  'bid_high',
  'bid_low',
  'bid_close',
  'ask_open',
  'ask_high',
  'ask_low',
  'ask_close',
] as const

export type PriceField = (typeof PRICE_FIELDS)[number]
export type ValidationStatus = 'pass' | 'warn' | 'fail'

export interface QuoteRow {
  readonly ts: number
  readonly exchange: string
  readonly symbol: string
  readonly bid_open: number | null
  readonly bid_high: number | null
  readonly bid_low: number | null
  readonly bid_close: number | null
  readonly ask_open: number | null
  readonly ask_high: number | null
  readonly ask_low: number | null
  readonly ask_close: number | null
  readonly source_type: string
  readonly is_interpolated: boolean
  readonly confidence_score: string
  readonly missing_reason: string | null
}

export interface QuoteDataDescriptor {
  readonly exchange: string
  readonly symbol: string
  readonly rowCount?: number
}

export interface QuoteReadResult {
  readonly rows: QuoteRow[]
  readonly columns: string[]
}

export interface OhlcViolationExample {
  readonly ts: number
  readonly side: 'bid' | 'ask'
  readonly message: string
}

export interface OhlcIntegrityResult {
  readonly violationCount: number
  readonly partialOhlcCount: number
  readonly negativePriceCount: number
  readonly zeroPriceOnNonInterpolatedCount: number
  readonly constraintViolationCount: number
  readonly examples: OhlcViolationExample[]
  readonly pass: boolean
}

export interface NegativeSpreadExample {
  readonly ts: number
  readonly field: 'open' | 'high' | 'low' | 'close'
  readonly bid: number
  readonly ask: number
  readonly spread: number
}

export interface SpreadValidityResult {
  readonly sourceType: string
  readonly totalNegativeSpreads: number
  readonly negativeSpreadCounts: Readonly<Record<'open' | 'high' | 'low' | 'close', number>>
  readonly worstNegativeSpread: NegativeSpreadExample | null
  readonly examples: NegativeSpreadExample[]
  readonly status: ValidationStatus
}

export interface TimeGapExample {
  readonly prevTs: number
  readonly currTs: number
  readonly deltaMs: number
  readonly missingSeconds: number
}

export interface TimeContinuityResult {
  readonly firstTs: number | null
  readonly lastTs: number | null
  readonly durationMs: number
  readonly expectedCandles: number
  readonly actualCandles: number
  readonly gapCount: number
  readonly duplicateCount: number
  readonly irregularStepCount: number
  readonly nonMonotonicCount: number
  readonly missingSeconds: number
  readonly gapExamples: TimeGapExample[]
  readonly pass: boolean
}

export interface InterpolationRunExample {
  readonly startTs: number
  readonly endTs: number
  readonly lengthSeconds: number
}

export interface InterpolationAnalysisResult {
  readonly interpolatedCount: number
  readonly interpolatedPercent: number
  readonly maxConsecutiveInterpolatedSeconds: number
  readonly runBuckets: Readonly<Record<'1s' | '2-5s' | '5-30s' | '30s-5m' | '>5m', number>>
  readonly longRuns: InterpolationRunExample[]
}

export interface PricePointStats {
  readonly min: number | null
  readonly max: number | null
  readonly mean: number | null
}

export interface InvalidPriceExample {
  readonly ts: number
  readonly field: PriceField
  readonly value: string
}

export interface ExtremeTickExample {
  readonly field: 'bid_close' | 'ask_close'
  readonly prevTs: number
  readonly ts: number
  readonly prevPrice: number
  readonly currPrice: number
  readonly changePercent: number
}

export interface PriceReasonablenessResult {
  readonly nanCount: number
  readonly infinityCount: number
  readonly invalidPriceExamples: InvalidPriceExample[]
  readonly extremeTickCount: number
  readonly extremeTickExamples: ExtremeTickExample[]
  readonly bidCloseStats: PricePointStats
  readonly askCloseStats: PricePointStats
  readonly status: ValidationStatus
}

export interface CrossExchangePoint {
  readonly ts: number
  readonly midPrice: number
}

export interface CrossExchangeSeriesInput {
  readonly exchange: string
  readonly symbol: string
  readonly points: CrossExchangePoint[]
}

export interface CrossExchangeExample {
  readonly ts: number
  readonly divergencePercent: number
  readonly lowExchange: string
  readonly highExchange: string
  readonly lowMidPrice: number
  readonly highMidPrice: number
}

export interface CrossExchangeResult {
  readonly symbol: string
  readonly exchanges: string[]
  readonly overlappingSeconds: number
  readonly meanDivergencePercent: number
  readonly maxDivergencePercent: number
  readonly divergenceAboveOnePercentCount: number
  readonly examples: CrossExchangeExample[]
}

export interface SchemaMetadataResult {
  readonly missingColumns: string[]
  readonly unexpectedColumns: string[]
  readonly exchangeValues: string[]
  readonly symbolValues: string[]
  readonly sourceTypeValues: string[]
  readonly confidenceScoreValues: string[]
  readonly exchangeConsistent: boolean
  readonly symbolConsistent: boolean
  readonly sourceTypeConsistent: boolean
  readonly confidenceScoreConsistent: boolean
  readonly exchangeMatchesDescriptor: boolean
  readonly symbolMatchesDescriptor: boolean
  readonly sourceTypeMatchesExpectedForExchange: boolean
  readonly confidenceMatchesSourceType: boolean
  readonly pass: boolean
}

export interface DayBoundaryGap {
  readonly previousDay: string
  readonly nextDay: string
  readonly previousTs: number
  readonly nextTs: number
  readonly deltaMs: number
  readonly missingSeconds: number
  readonly priceJumpPercent: number | null
  readonly midnightMissing: boolean
}

export interface DayBoundaryContinuityResult {
  readonly dayCount: number
  readonly checkedBoundaryCount: number
  readonly gapAtBoundaryCount: number
  readonly midnightMissingCount: number
  readonly priceJumpCount: number
  readonly examples: DayBoundaryGap[]
  readonly pass: boolean
}

export interface DayQualityEntry {
  readonly date: string
  readonly candleCount: number
  readonly expectedCandles: number
  readonly coveragePercent: number
  readonly interpolationPercent: number
  readonly gapCount: number
  readonly missingSeconds: number
  readonly qualityScore: number
  readonly partialDay: boolean
}

export interface PerDayBreakdownResult {
  readonly days: DayQualityEntry[]
  readonly badDayCount: number
  readonly badDays: string[]
  readonly partialDayCount: number
  readonly bestDay: DayQualityEntry | null
  readonly worstDay: DayQualityEntry | null
}

export interface StaleRunExample {
  readonly startTs: number
  readonly endTs: number
  readonly lengthSeconds: number
  readonly bidClose: number
  readonly askClose: number
}

export interface StalePriceResult {
  readonly staleSeconds: number
  readonly stalePercent: number
  readonly runCount: number
  readonly longestRunSeconds: number
  readonly runBuckets: Readonly<Record<'1-10s' | '10-60s' | '1-5m' | '>5m', number>>
  readonly examples: StaleRunExample[]
  readonly status: ValidationStatus
}

export interface SpreadDistributionResult {
  readonly sampleCount: number
  readonly thresholdBps: number
  readonly meanBps: number | null
  readonly medianBps: number | null
  readonly p75Bps: number | null
  readonly p95Bps: number | null
  readonly p99Bps: number | null
  readonly stddevBps: number | null
  readonly unreasonableCount: number
  readonly unreasonablePercent: number
  readonly status: ValidationStatus
}

export interface InterpolationDamageResult {
  readonly boundaryCount: number
  readonly damageScore: number
  readonly highDamageCount: number
  readonly maxBoundaryChangePercent: number
}

export interface TimestampAlignmentResult {
  readonly firstTs: number | null
  readonly lastTs: number | null
  readonly firstOffsetSeconds: number | null
  readonly lastOffsetSeconds: number | null
  readonly pass: boolean
}

export interface QualityDeductions {
  readonly interpolation: number
  readonly gaps: number
  readonly ohlc: number
  readonly spread: number
  readonly extremeTicks: number
  readonly dayBoundary: number
  readonly stalePrice: number
}

export interface CompletenessResult {
  readonly expectedCandles: number
  readonly actualCandles: number
  readonly coveragePercent: number
  readonly qualityScore: number
  readonly deductions: QualityDeductions
}

export interface FileValidationResult {
  readonly descriptor: QuoteDataDescriptor
  readonly rowCount: number
  readonly sourceType: string
  readonly confidenceScore: string
  readonly ohlc: OhlcIntegrityResult
  readonly spread: SpreadValidityResult
  readonly timeContinuity: TimeContinuityResult
  readonly interpolation: InterpolationAnalysisResult
  readonly priceReasonableness: PriceReasonablenessResult
  readonly schemaMetadata: SchemaMetadataResult
  readonly dayBoundary: DayBoundaryContinuityResult
  readonly perDayBreakdown: PerDayBreakdownResult
  readonly stalePrice: StalePriceResult
  readonly spreadDistribution: SpreadDistributionResult
  readonly interpolationDamage: InterpolationDamageResult
  readonly timestampAlignment: TimestampAlignmentResult
  readonly completeness: CompletenessResult
  readonly criticalFailures: string[]
  readonly status: ValidationStatus
}

export interface ValidationSummary {
  readonly fileCount: number
  readonly passedFiles: number
  readonly warnedFiles: number
  readonly failedFiles: number
  readonly criticalFailureCount: number
  readonly averageQualityScore: number
  readonly minQualityScore: number
}

export interface QuoteValidationReport {
  readonly generatedAt: string
  readonly files: FileValidationResult[]
  readonly crossExchange: CrossExchangeResult[]
  readonly summary: ValidationSummary
}
