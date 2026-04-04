import type { ParserKey } from '../parsers/index.js'
import type { ConfidenceScore, SourceType } from '../types.js'

export interface DownloadResult {
  readonly filePaths: string[]
  readonly totalSizeBytes: number
}

export interface ExchangeDownloader {
  readonly exchange: string
  readonly parserKey: ParserKey
  readonly sourceType: SourceType
  readonly confidenceScore: ConfidenceScore
  constructUrls(symbol: string, date: Date): string[]
  toUrlSymbol(normalizedSymbol: string): string
}
