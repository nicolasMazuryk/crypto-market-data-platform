import type { QuoteDataDescriptor, QuoteRow, SchemaMetadataResult } from './types.js'
import { REQUIRED_QUOTE_COLUMNS } from './types.js'

const EXPECTED_SOURCE_TYPE_BY_EXCHANGE: Record<string, 'orderbook' | 'trades'> = {
  binance: 'trades',
  bybit: 'orderbook',
  okx: 'orderbook',
  gateio: 'orderbook',
  bitget: 'trades',
  kucoin: 'orderbook',
}

function toSortedValues(values: Set<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right))
}

function expectedConfidenceForSourceType(sourceType: string): string {
  return sourceType === 'orderbook' ? 'high' : 'low'
}

export class SchemaMetadataAccumulator {
  private readonly descriptor: QuoteDataDescriptor
  private readonly missingColumns: string[]
  private readonly unexpectedColumns: string[]
  private readonly exchangeValues = new Set<string>()
  private readonly symbolValues = new Set<string>()
  private readonly sourceTypeValues = new Set<string>()
  private readonly confidenceScoreValues = new Set<string>()
  private confidenceMatchesSourceType = true
  private firstSourceType: string | null = null
  private firstConfidenceScore: string | null = null

  constructor(descriptor: QuoteDataDescriptor, columns: string[] = [...REQUIRED_QUOTE_COLUMNS]) {
    this.descriptor = descriptor

    const expectedColumns = new Set<string>(REQUIRED_QUOTE_COLUMNS)
    const actualColumns = new Set<string>(columns)

    this.missingColumns = REQUIRED_QUOTE_COLUMNS.filter(column => !actualColumns.has(column))
    this.unexpectedColumns = columns
      .filter(column => !expectedColumns.has(column))
      .sort((left, right) => left.localeCompare(right))
  }

  update(row: QuoteRow): void {
    this.firstSourceType ??= row.source_type

    this.firstConfidenceScore ??= row.confidence_score

    this.exchangeValues.add(row.exchange)
    this.symbolValues.add(row.symbol)
    this.sourceTypeValues.add(row.source_type)
    this.confidenceScoreValues.add(row.confidence_score)

    if (row.confidence_score !== expectedConfidenceForSourceType(row.source_type)) {
      this.confidenceMatchesSourceType = false
    }
  }

  getFirstSourceType(): string {
    return this.firstSourceType ?? 'unknown'
  }

  getFirstConfidenceScore(): string {
    return this.firstConfidenceScore ?? 'unknown'
  }

  finalize(): SchemaMetadataResult {
    const normalizedExchangeValues = toSortedValues(this.exchangeValues)
    const normalizedSymbolValues = toSortedValues(this.symbolValues)
    const normalizedSourceTypeValues = toSortedValues(this.sourceTypeValues)
    const normalizedConfidenceValues = toSortedValues(this.confidenceScoreValues)

    const exchangeConsistent = normalizedExchangeValues.length === 1
    const symbolConsistent = normalizedSymbolValues.length === 1
    const sourceTypeConsistent = normalizedSourceTypeValues.length === 1
    const confidenceScoreConsistent = normalizedConfidenceValues.length === 1

    const exchangeMatchesDescriptor = exchangeConsistent && normalizedExchangeValues[0] === this.descriptor.exchange
    const symbolMatchesDescriptor = symbolConsistent && normalizedSymbolValues[0] === this.descriptor.symbol

    const expectedSourceType = EXPECTED_SOURCE_TYPE_BY_EXCHANGE[this.descriptor.exchange]
    const sourceTypeMatchesExpectedForExchange =
      expectedSourceType === undefined
        ? true
        : sourceTypeConsistent && normalizedSourceTypeValues[0] === expectedSourceType

    const pass =
      this.missingColumns.length === 0 &&
      this.unexpectedColumns.length === 0 &&
      exchangeConsistent &&
      symbolConsistent &&
      sourceTypeConsistent &&
      confidenceScoreConsistent &&
      exchangeMatchesDescriptor &&
      symbolMatchesDescriptor &&
      sourceTypeMatchesExpectedForExchange &&
      this.confidenceMatchesSourceType

    return {
      missingColumns: [...this.missingColumns],
      unexpectedColumns: [...this.unexpectedColumns],
      exchangeValues: normalizedExchangeValues,
      symbolValues: normalizedSymbolValues,
      sourceTypeValues: normalizedSourceTypeValues,
      confidenceScoreValues: normalizedConfidenceValues,
      exchangeConsistent,
      symbolConsistent,
      sourceTypeConsistent,
      confidenceScoreConsistent,
      exchangeMatchesDescriptor,
      symbolMatchesDescriptor,
      sourceTypeMatchesExpectedForExchange,
      confidenceMatchesSourceType: this.confidenceMatchesSourceType,
      pass,
    }
  }
}

export function validateSchemaMetadata(
  descriptor: QuoteDataDescriptor,
  columns: string[],
  rows: QuoteRow[]
): SchemaMetadataResult {
  const accumulator = new SchemaMetadataAccumulator(descriptor, columns)

  for (const row of rows) {
    accumulator.update(row)
  }

  return accumulator.finalize()
}
