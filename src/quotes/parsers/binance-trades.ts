import { readZipLines } from '../extract/index.js'
import type { QuoteParser } from '../types.js'
import { createTradeQuoteEvent, splitCsvLine, toFiniteNumber } from './csv.js'

export const binanceTradesParser: QuoteParser = {
  sourceType: 'trades',
  confidenceScore: 'low',

  async *parse(filePath: string) {
    let isHeader = true

    for await (const line of readZipLines(filePath)) {
      if (line.trim().length === 0) {
        continue
      }

      if (isHeader) {
        isHeader = false
        continue
      }

      const columns = splitCsvLine(line)
      const price = toFiniteNumber(columns[1])
      const timestampMs = toFiniteNumber(columns[5])
      const isBuyerMaker = columns[6]

      if (price === null || timestampMs === null || (isBuyerMaker !== 'true' && isBuyerMaker !== 'false')) {
        continue
      }

      const side = isBuyerMaker === 'true' ? 'sell' : 'buy'
      yield createTradeQuoteEvent(timestampMs, price, side)
    }
  },
}
