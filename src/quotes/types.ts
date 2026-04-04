export type SourceType = 'orderbook' | 'trades'
export type ConfidenceScore = 'high' | 'low'

export interface QuoteEvent {
  readonly timestampMs: number
  readonly bid: number | null
  readonly ask: number | null
  readonly sourceType: SourceType
}

export interface QuoteCandle1s {
  readonly ts: number
  readonly exchange: string
  readonly symbol: string
  readonly bidOpen: number | null
  readonly bidHigh: number | null
  readonly bidLow: number | null
  readonly bidClose: number | null
  readonly askOpen: number | null
  readonly askHigh: number | null
  readonly askLow: number | null
  readonly askClose: number | null
  readonly sourceType: SourceType
  readonly isInterpolated: boolean
  readonly confidenceScore: ConfidenceScore
  readonly missingReason: string | null
}

export interface QuoteParser {
  readonly sourceType: SourceType
  readonly confidenceScore: ConfidenceScore
  parse(filePath: string): AsyncIterable<QuoteEvent>
}

export interface QuoteAggregationContext {
  readonly exchange: string
  readonly symbol: string
  readonly sourceType: SourceType
  readonly confidenceScore: ConfidenceScore
}

export interface ProcessedTask {
  readonly exchange: string
  readonly symbol: string
  readonly date: string
  readonly rowsWritten: number
  readonly errorMessage?: string
}
