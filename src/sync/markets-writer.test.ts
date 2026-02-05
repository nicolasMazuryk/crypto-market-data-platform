import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, it, expect, afterEach } from 'vitest'

import type { Market } from '../exchanges/types.js'
import { writeMarketsSnapshot } from './markets-writer.js'

describe('writeMarketsSnapshot', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  it('writes per-exchange JSON files with ISO date strings', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'markets-sync-'))

    const listingDate = new Date(Date.UTC(2025, 0, 1, 0, 0, 0))
    const delistingDate = new Date(Date.UTC(2026, 1, 6, 9, 0, 0))

    const markets: Market[] = [
      {
        exchange: 'binance',
        symbol: 'ETHUSDT',
        exchange_symbol: 'ETHUSDT',
        type: 'perpetual',
        listing_date: listingDate,
        delisting_date: null,
        is_active: true
      },
      {
        exchange: 'binance',
        symbol: 'BTCUSDT',
        exchange_symbol: 'BTCUSDT',
        type: 'perpetual',
        listing_date: null,
        delisting_date: delistingDate,
        is_active: false
      },
      {
        exchange: 'bybit',
        symbol: 'SOLUSDT',
        exchange_symbol: 'SOLUSDT',
        type: 'perpetual',
        listing_date: null,
        delisting_date: null,
        is_active: true
      }
    ]

    await writeMarketsSnapshot(markets, tempDir)

    const binanceFile = path.join(tempDir, 'binance.json')
    const bybitFile = path.join(tempDir, 'bybit.json')

    const binanceData = JSON.parse(await readFile(binanceFile, 'utf8'))
    const bybitData = JSON.parse(await readFile(bybitFile, 'utf8'))

    expect(binanceData).toEqual([
      {
        exchange: 'binance',
        symbol: 'BTCUSDT',
        exchange_symbol: 'BTCUSDT',
        type: 'perpetual',
        listing_date: null,
        delisting_date: delistingDate.toISOString(),
        is_active: false
      },
      {
        exchange: 'binance',
        symbol: 'ETHUSDT',
        exchange_symbol: 'ETHUSDT',
        type: 'perpetual',
        listing_date: listingDate.toISOString(),
        delisting_date: null,
        is_active: true
      }
    ])

    expect(bybitData).toEqual([
      {
        exchange: 'bybit',
        symbol: 'SOLUSDT',
        exchange_symbol: 'SOLUSDT',
        type: 'perpetual',
        listing_date: null,
        delisting_date: null,
        is_active: true
      }
    ])
  })
})
