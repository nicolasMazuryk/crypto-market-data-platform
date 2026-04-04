import fs from 'node:fs/promises'

import { readGzipLines } from '../extract/index.js'
import type { QuoteEvent } from '../types.js'
import { GateOrderbookProcessor } from './gate-orderbook-processor.js'

export async function* parseGateMultiFile(filePaths: string[]): AsyncIterable<QuoteEvent> {
  const sorted = [...filePaths].sort((left, right) => left.localeCompare(right))
  const processor = new GateOrderbookProcessor()

  for (const filePath of sorted) {
    try {
      for await (const line of readGzipLines(filePath)) {
        const event = processor.pushLine(line)
        if (event) {
          yield event
        }
      }
    } finally {
      try {
        await fs.unlink(filePath)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`Failed to delete Gate.io source file ${filePath}: ${message}`)
      }
    }
  }

  const finalEvent = processor.finish()
  if (finalEvent) {
    yield finalEvent
  }
}
