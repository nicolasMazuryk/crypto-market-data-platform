import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { createTradeQuoteEvent, splitCsvLine } from '../parsers/csv.js'
import { gateOrderbookParser } from '../parsers/gate-orderbook.js'
import { getParser } from '../parsers/index.js'

describe('parser utilities', () => {
  it('handles empty CSV lines', () => {
    expect(splitCsvLine('')).toEqual([''])
  })

  it('parses plain CSV lines using the non-quoted fast path', () => {
    const columns = splitCsvLine('a,b,c,d')
    expect(columns).toEqual(['a', 'b', 'c', 'd'])
  })

  it('parses CSV lines containing quoted commas', () => {
    const columns = splitCsvLine('a,"b,c",d')
    expect(columns).toEqual(['a', 'b,c', 'd'])
  })

  it('parses CSV lines with only quoted fields', () => {
    const columns = splitCsvLine('"a","b","c"')
    expect(columns).toEqual(['a', 'b', 'c'])
  })

  it('maps trade side to one-sided quote events', () => {
    const buyEvent = createTradeQuoteEvent(1_000, 10.5, 'buy')
    const sellEvent = createTradeQuoteEvent(2_000, 10.4, 'sell')

    expect(buyEvent).toEqual({
      timestampMs: 1_000,
      bid: null,
      ask: 10.5,
      sourceType: 'trades',
    })

    expect(sellEvent).toEqual({
      timestampMs: 2_000,
      bid: 10.4,
      ask: null,
      sourceType: 'trades',
    })
  })

  it('exposes parser metadata through the registry', () => {
    expect(getParser('bybit-orderbook').sourceType).toBe('orderbook')
    expect(getParser('bybit-orderbook').confidenceScore).toBe('high')
    expect(getParser('binance-trades').sourceType).toBe('trades')
    expect(getParser('binance-trades').confidenceScore).toBe('low')
  })

  it('handles gate orderbook make/take deltas after the initial set', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-parser-'))
    const filePath = path.join(tmpDir, 'gate.csv.gz')
    const lines = [
      '1764460800,set,2.0000,100,1,0',
      '1764460800,set,2.1000,-100,2,0',
      '1764460801,make,2.0000,50,3,0',
      '1764460802,take,2.0000,120,4,0',
      '1764460802,make,2.2000,-10,5,0',
      '1764460803,take,2.1000,-100,6,0',
    ]

    await fs.writeFile(filePath, gzipSync(lines.join('\n')))

    const events = []
    for await (const event of gateOrderbookParser.parse(filePath)) {
      events.push(event)
    }

    await fs.rm(tmpDir, { recursive: true, force: true })

    expect(events).toHaveLength(4)
    expect(events[0]).toMatchObject({ timestampMs: 1764460800000, bid: 2, ask: 2.1 })
    expect(events[1]).toMatchObject({ timestampMs: 1764460801000, bid: 2, ask: 2.1 })
    expect(events[2]).toMatchObject({ timestampMs: 1764460802000, bid: 2, ask: 2.1 })
    expect(events[3]).toMatchObject({ timestampMs: 1764460803000, bid: 2, ask: 2.2 })
  })
})
