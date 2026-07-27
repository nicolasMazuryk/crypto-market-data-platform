import { readZipLines } from '../extract/index.js'
import type { QuoteEvent, QuoteParser } from '../types.js'
import { createTradeQuoteEvent, splitCsvLine, toFiniteNumber } from './csv.js'

export const bitgetTradesParser: QuoteParser = {
  sourceType: 'trades',
  confidenceScore: 'low',

  async *parse(filePath: string) {
    let isHeader = true
    const events: QuoteEvent[] = []

    for await (const line of readZipLines(filePath)) {
      if (line.trim().length === 0) {
        continue
      }

      if (isHeader) {
        isHeader = false
        continue
      }

      const columns = splitCsvLine(line)
      const timestampMs = toFiniteNumber(columns[1])
      const price = toFiniteNumber(columns[2])
      const side = columns[3]?.trim().toLowerCase()

      if (timestampMs === null || price === null || price <= 0 || (side !== 'buy' && side !== 'sell')) {
        continue
      }

      // `side` is the taker side: a buy lifts the ask, a sell hits the bid.
      events.push(createTradeQuoteEvent(timestampMs, price, side))
    }

    // Parts are ~100k rows and the aggregator rejects out-of-order input, so
    // buffering one part to sort it is cheap insurance.
    events.sort((left, right) => left.timestampMs - right.timestampMs)

    for (const event of events) {
      yield event
    }
  },
}
