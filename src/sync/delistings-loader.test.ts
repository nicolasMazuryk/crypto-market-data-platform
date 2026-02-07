import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { Market } from '../exchanges/types.js'
import { createExchangeSymbolResolver } from '../exchanges/symbol-resolver.js'

function ensureRequiredConfigEnv(): void {
  process.env.DATA_PERIOD_START = '2025-01-01T00:00:00Z'
  process.env.FUNDING_RATE_MAX_RETRIES = '5'
  process.env.FUNDING_RATE_BACKOFF_BASE_MS = '750'
  process.env.FUNDING_RATE_BACKOFF_MAX_MS = '30000'
  process.env.FUNDING_RATE_PAGE_SIZE = '100'
  process.env.EXCHANGE_SYNC_CONCURRENCY = '1'
  process.env.FUNDING_RATE_SYMBOL_CONCURRENCY = '5'
  process.env.DELISTINGS_DIR = 'src/markets/delistings'
  process.env.MIGRATIONS_DIR = 'src/db/migrations'
}

describe('loadDelistingsForExchange', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  it('normalizes symbols, resolves exchange format, and parses UTC delisting dates', async () => {
    ensureRequiredConfigEnv()
    const { loadDelistingsForExchange } = await import('./delistings-loader.js')

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'delistings-'))
    const delistingsDir = path.join(tempDir, 'delistings')
    await mkdir(delistingsDir, { recursive: true })

    const filePath = path.join(delistingsDir, 'mexc.json')
    await writeFile(
      filePath,
      JSON.stringify({
        '1000RATSUSDT': '2026-02-06 09:00',
      })
    )

    const activeMarkets: Market[] = [
      {
        exchange: 'mexc',
        symbol: '1000RATSUSDT',
        exchange_symbol: '1000RATS_USDT',
        type: 'perpetual',
        listing_date: null,
        delisting_date: null,
        is_active: true,
      },
    ]

    const resolver = createExchangeSymbolResolver('mexc', activeMarkets)
    const markets = await loadDelistingsForExchange('mexc', resolver, delistingsDir)

    expect(markets).toHaveLength(1)
    const market = markets[0]
    if (!market) {
      throw new Error('Expected delisted market')
    }

    expect(market).toMatchObject({
      exchange: 'mexc',
      symbol: '1000RATSUSDT',
      exchange_symbol: '1000RATS_USDT',
      type: 'perpetual',
      listing_date: null,
      is_active: false,
    })

    expect(market.delisting_date?.toISOString()).toBe('2026-02-06T09:00:00.000Z')

    const persistedRaw: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    if (persistedRaw === null || typeof persistedRaw !== 'object') {
      throw new Error('Expected persisted JSON object')
    }
    const persisted = persistedRaw as Record<string, string>
    expect(persisted['1000RATSUSDT']).toBe('2026-02-06 09:00')
  })
})
