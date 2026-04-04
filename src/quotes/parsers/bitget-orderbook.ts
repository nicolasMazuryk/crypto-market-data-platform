import * as xlsx from 'xlsx'

import { readFirstZipEntryBuffer } from '../extract/index.js'
import type { QuoteEvent, QuoteParser } from '../types.js'
import { toFiniteNumber } from './csv.js'

interface BitgetSheetRow {
  readonly timestamp?: unknown
  readonly ask_price?: unknown
  readonly bid_price?: unknown
}

function toNumericString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value)
  }

  return null
}

function toTimestampMs(value: unknown): number | null {
  const parsed = toFiniteNumber(toNumericString(value))
  if (parsed === null) {
    return null
  }

  return parsed < 1_000_000_000_000 ? Math.round(parsed * 1000) : Math.round(parsed)
}

function rowToEvent(row: BitgetSheetRow): QuoteEvent | null {
  const timestampMs = toTimestampMs(row.timestamp)
  if (timestampMs === null) {
    return null
  }

  const bid = toFiniteNumber(toNumericString(row.bid_price))
  const ask = toFiniteNumber(toNumericString(row.ask_price))

  return {
    timestampMs,
    bid,
    ask,
    sourceType: 'orderbook',
  }
}

function timestampForSort(row: BitgetSheetRow): number {
  const timestampMs = toTimestampMs(row.timestamp)
  return timestampMs ?? Number.POSITIVE_INFINITY
}

export const bitgetOrderbookParser: QuoteParser = {
  sourceType: 'orderbook',
  confidenceScore: 'high',

  async *parse(filePath: string) {
    const workbookBuffer = await readFirstZipEntryBuffer(filePath)
    const workbook = xlsx.read(workbookBuffer, { type: 'buffer', raw: false })
    const firstSheetName = workbook.SheetNames[0]

    if (firstSheetName === undefined) {
      throw new Error(`No worksheets found in ${filePath}`)
    }

    const sheet = workbook.Sheets[firstSheetName]
    if (!sheet) {
      throw new Error(`Worksheet ${firstSheetName} not found in ${filePath}`)
    }

    const rows = xlsx.utils.sheet_to_json<BitgetSheetRow>(sheet, {
      raw: false,
      defval: null,
    })

    rows.sort((left, right) => timestampForSort(left) - timestampForSort(right))

    for (const row of rows) {
      const event = rowToEvent(row)
      if (event === null) {
        continue
      }

      yield event
    }
  },
}
