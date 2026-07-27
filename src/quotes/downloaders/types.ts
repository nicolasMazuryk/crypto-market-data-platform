import type { ParserKey } from '../parsers/index.js'
import type { ConfidenceScore, SourceType } from '../types.js'

export interface DownloadResult {
  readonly filePaths: string[]
  readonly totalSizeBytes: number
}

export interface ListUrlsOptions {
  readonly onInfo?: (message: string) => void
}

export interface ExchangeDownloader {
  readonly exchange: string
  readonly parserKey: ParserKey
  readonly sourceType: SourceType
  readonly confidenceScore: ConfidenceScore
  constructUrls(symbol: string, date: Date): string[]
  /**
   * Async URL discovery for exchanges whose file list can only be resolved at
   * runtime (e.g. a per-symbol-day part count). Preferred over `constructUrls`
   * when present.
   */
  listUrls?(symbol: string, date: Date, options?: ListUrlsOptions): Promise<string[]>
  toUrlSymbol(normalizedSymbol: string): string
}
