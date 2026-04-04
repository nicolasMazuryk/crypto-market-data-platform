import { readGzipLines } from '../extract/index.js'
import type { QuoteParser } from '../types.js'
import { GateOrderbookProcessor } from './gate-orderbook-processor.js'

export const gateOrderbookParser: QuoteParser = {
  sourceType: 'orderbook',
  confidenceScore: 'high',

  async *parse(filePath: string) {
    const processor = new GateOrderbookProcessor()

    for await (const line of readGzipLines(filePath)) {
      const event = processor.pushLine(line)
      if (event) {
        yield event
      }
    }

    const finalEvent = processor.finish()
    if (finalEvent) {
      yield finalEvent
    }
  },
}
