import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { closeClickHouseClient } from '../client.js'
import { createClickHouseFixtureCleanupRegistry } from '../fixtureCleanup.js'
import { pingClickHouse } from '../health.js'
import { insertDownloadTasks, listCompletedTaskKeys } from '../queries/downloadTasks.js'
import {
  insertFundingRates,
  queryFundingEventsBelowThreshold,
  queryThresholdAnalysis,
} from '../queries/fundingRates.js'
import { toClickHouseDateTime, type FundingRateRow } from '../types.js'

const cleanupRegistry = createClickHouseFixtureCleanupRegistry()

function trackExchange(table: 'funding_rates' | 'download_tasks' | 'markets', exchange: string): string {
  cleanupRegistry.track(table, exchange)
  return exchange
}

describe('funding download task queries', () => {
  beforeAll(async () => {
    const healthy = await pingClickHouse()
    if (!healthy) {
      throw new Error('ClickHouse is not reachable. Run: npm run db:up')
    }
  })

  afterEach(async () => {
    await cleanupRegistry.cleanup()
  })

  afterAll(async () => {
    try {
      await cleanupRegistry.cleanup()
    } finally {
      await closeClickHouseClient()
    }
  })

  describe('queryFundingEventsBelowThreshold', () => {
    it('returns events with funding rate below threshold', async () => {
      const runId = randomUUID().slice(0, 8)
      const exchange = trackExchange('funding_rates', `evt_${runId}`)
      const now = toClickHouseDateTime(new Date())

      const rows: FundingRateRow[] = [
        {
          exchange,
          symbol: 'BTCUSDT',
          exchange_symbol: 'BTCUSDT',
          funding_time: '2025-06-15 08:00:00',
          funding_rate: '-0.006',
          mark_price: '50000',
          created_at: now,
        },
        {
          exchange,
          symbol: 'BTCUSDT',
          exchange_symbol: 'BTCUSDT',
          funding_time: '2025-06-15 16:00:00',
          funding_rate: '-0.007',
          mark_price: '50100',
          created_at: now,
        },
        {
          exchange,
          symbol: 'ETHUSDT',
          exchange_symbol: 'ETHUSDT',
          funding_time: '2025-06-16 00:00:00',
          funding_rate: '-0.010',
          mark_price: '3000',
          created_at: now,
        },
        {
          exchange,
          symbol: 'BTCUSDT',
          exchange_symbol: 'BTCUSDT',
          funding_time: '2025-06-17 08:00:00',
          funding_rate: '0.001',
          mark_price: '51000',
          created_at: now,
        },
      ]

      await insertFundingRates(rows)

      const events = await queryFundingEventsBelowThreshold(-0.005, '2025-06-01', '2025-06-30', [])

      const filtered = events.filter(e => e.exchange === exchange)

      // BTC on 6/15 (two events but grouped by date = 1 row), ETH on 6/16
      expect(filtered).toHaveLength(2)

      const btcEvent = filtered.find(e => e.symbol === 'BTCUSDT')
      expect(btcEvent).toBeTruthy()
      expect(btcEvent?.funding_date).toBe('2025-06-15')
      expect(btcEvent?.is_midnight).toBe(0)

      const ethEvent = filtered.find(e => e.symbol === 'ETHUSDT')
      expect(ethEvent).toBeTruthy()
      expect(ethEvent?.funding_date).toBe('2025-06-16')
      expect(ethEvent?.is_midnight).toBe(1) // 00:00:00 is midnight
    })

    it('excludes specified exchanges', async () => {
      const runId = randomUUID().slice(0, 8)
      const exchange1 = trackExchange('funding_rates', `inc_${runId}`)
      const exchange2 = trackExchange('funding_rates', `exc_${runId}`)
      const now = toClickHouseDateTime(new Date())

      await insertFundingRates([
        {
          exchange: exchange1,
          symbol: 'BTCUSDT',
          exchange_symbol: 'BTCUSDT',
          funding_time: '2025-06-15 08:00:00',
          funding_rate: '-0.01',
          mark_price: '50000',
          created_at: now,
        },
        {
          exchange: exchange2,
          symbol: 'BTCUSDT',
          exchange_symbol: 'BTCUSDT',
          funding_time: '2025-06-15 08:00:00',
          funding_rate: '-0.01',
          mark_price: '50000',
          created_at: now,
        },
      ])

      const events = await queryFundingEventsBelowThreshold(-0.005, '2025-06-01', '2025-06-30', [exchange2])

      const relevant = events.filter(e => e.exchange === exchange1 || e.exchange === exchange2)
      expect(relevant).toHaveLength(1)
      expect(relevant[0].exchange).toBe(exchange1)
    })

    it('returns empty for rates above threshold', async () => {
      const runId = randomUUID().slice(0, 8)
      const exchange = trackExchange('funding_rates', `above_${runId}`)
      const now = toClickHouseDateTime(new Date())

      await insertFundingRates([
        {
          exchange,
          symbol: 'BTCUSDT',
          exchange_symbol: 'BTCUSDT',
          funding_time: '2025-06-15 08:00:00',
          funding_rate: '0.001',
          mark_price: '50000',
          created_at: now,
        },
      ])

      const events = await queryFundingEventsBelowThreshold(-0.005, '2025-06-01', '2025-06-30', [])

      const filtered = events.filter(e => e.exchange === exchange)
      expect(filtered).toHaveLength(0)
    })
  })

  describe('queryThresholdAnalysis', () => {
    it('returns correct aggregate stats', async () => {
      const runId = randomUUID().slice(0, 8)
      const ex1 = trackExchange('funding_rates', `an1_${runId}`)
      const ex2 = trackExchange('funding_rates', `an2_${runId}`)
      const now = toClickHouseDateTime(new Date())

      await insertFundingRates([
        // ex1 BTCUSDT on 6/15 at 08:00
        {
          exchange: ex1,
          symbol: 'BTCUSDT',
          exchange_symbol: 'BTCUSDT',
          funding_time: '2025-06-15 08:00:00',
          funding_rate: '-0.01',
          mark_price: '50000',
          created_at: now,
        },
        // ex2 BTCUSDT on 6/15 at 00:00 (midnight)
        {
          exchange: ex2,
          symbol: 'BTCUSDT',
          exchange_symbol: 'BTCUSDT',
          funding_time: '2025-06-15 00:00:00',
          funding_rate: '-0.008',
          mark_price: '50000',
          created_at: now,
        },
        // ex1 ETHUSDT on 6/16 at 08:00
        {
          exchange: ex1,
          symbol: 'ETHUSDT',
          exchange_symbol: 'ETHUSDT',
          funding_time: '2025-06-16 08:00:00',
          funding_rate: '-0.012',
          mark_price: '3000',
          created_at: now,
        },
      ])

      const stats = await queryThresholdAnalysis(-0.005, '2025-06-01', '2025-06-30', [])

      // These are from a shared DB, so stats include other test data.
      // We can only check the values are >= our expected minimums.
      expect(stats.unique_symbols).toBeGreaterThanOrEqual(2) // BTCUSDT, ETHUSDT
      expect(stats.exchange_symbol_days).toBeGreaterThanOrEqual(3) // 3 events above
      expect(stats.symbol_days).toBeGreaterThanOrEqual(2) // BTC on 6/15, ETH on 6/16
      expect(stats.midnight_events).toBeGreaterThanOrEqual(1) // ex2 BTC at 00:00
    })
  })

  describe('listCompletedTaskKeys', () => {
    it('returns keys for completed tasks', async () => {
      const runId = randomUUID().slice(0, 8)
      const exchange = trackExchange('download_tasks', `comp_${runId}`)
      const now = toClickHouseDateTime(new Date())

      await insertDownloadTasks([
        {
          exchange,
          symbol: 'BTCUSDT',
          date: '2025-06-15',
          status: 'completed',
          error_message: null,
          file_size_bytes: 1000,
          rows_written: 100,
          quality_score: 1.0,
          created_at: now,
          updated_at: now,
        },
        {
          exchange,
          symbol: 'ETHUSDT',
          date: '2025-06-15',
          status: 'pending',
          error_message: null,
          file_size_bytes: null,
          rows_written: null,
          quality_score: null,
          created_at: now,
          updated_at: now,
        },
      ])

      const keys = await listCompletedTaskKeys()
      expect(keys.has(`${exchange}:BTCUSDT:2025-06-15`)).toBe(true)
      expect(keys.has(`${exchange}:ETHUSDT:2025-06-15`)).toBe(false)
    })

    it('returns empty set when no completed tasks', async () => {
      const runId = randomUUID().slice(0, 8)
      const exchange = trackExchange('download_tasks', `empty_${runId}`)
      const now = toClickHouseDateTime(new Date())

      await insertDownloadTasks([
        {
          exchange,
          symbol: 'BTCUSDT',
          date: '2025-06-20',
          status: 'pending',
          error_message: null,
          file_size_bytes: null,
          rows_written: null,
          quality_score: null,
          created_at: now,
          updated_at: now,
        },
      ])

      const keys = await listCompletedTaskKeys()
      expect(keys.has(`${exchange}:BTCUSDT:2025-06-20`)).toBe(false)
    })
  })
})
