import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { config } from '../../config.js'
import { closeClickHouseClient, getClickHouseClient } from '../client.js'
import { createClickHouseFixtureCleanupRegistry } from '../fixtureCleanup.js'
import { pingClickHouse } from '../health.js'
import {
  countTasksByStatus,
  insertDownloadTasks,
  listExchangeTaskProgress,
  listFailedTasks,
  listPendingTasks,
  resetStaleTasks,
  updateTaskStatus,
} from '../queries/downloadTasks.js'
import { toClickHouseDateTime, type DownloadTaskRow } from '../types.js'

interface ColumnDef {
  name: string
  type: string
}

const database = config.clickhouse.database

const expectedColumns: ColumnDef[] = [
  { name: 'exchange', type: 'LowCardinality(String)' },
  { name: 'symbol', type: 'String' },
  { name: 'date', type: 'Date' },
  { name: 'status', type: "Enum8('pending' = 0, 'downloading' = 1, 'processing' = 2, 'completed' = 3, 'failed' = 4)" },
  { name: 'error_message', type: 'Nullable(String)' },
  { name: 'file_size_bytes', type: 'Nullable(UInt64)' },
  { name: 'rows_written', type: 'Nullable(UInt32)' },
  { name: 'quality_score', type: 'Nullable(Float32)' },
  { name: 'created_at', type: 'DateTime' },
  { name: 'updated_at', type: 'DateTime' },
]

const cleanupRegistry = createClickHouseFixtureCleanupRegistry()

function trackDownloadTaskExchange(exchange: string): string {
  cleanupRegistry.track('download_tasks', exchange)
  return exchange
}

async function fetchColumns(table: string): Promise<ColumnDef[]> {
  const client = getClickHouseClient()
  const result = await client.query({
    query:
      'SELECT name, type FROM system.columns WHERE database = {database: String} AND table = {table: String} ORDER BY position',
    query_params: { database, table },
    format: 'JSONEachRow',
  })

  return result.json<ColumnDef>()
}

function assertSchema(expected: ColumnDef[], actual: ColumnDef[]): void {
  const actualMap = new Map(actual.map(column => [column.name, column.type]))

  for (const column of expected) {
    const found = actualMap.get(column.name)
    expect(found, `Missing column ${column.name}`).toBeTruthy()
    expect(found).toBe(column.type)
  }
}

describe('download_tasks table', () => {
  beforeAll(async () => {
    const healthy = await pingClickHouse()
    if (!healthy) {
      throw new Error('ClickHouse is not reachable. Run: npm run db:up')
    }

    const client = getClickHouseClient()
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS arbinet.download_tasks
        (
            exchange LowCardinality(String),
            symbol String,
            date Date,
            status Enum8('pending' = 0, 'downloading' = 1, 'processing' = 2, 'completed' = 3, 'failed' = 4),
            error_message Nullable(String),
            file_size_bytes Nullable(UInt64),
            rows_written Nullable(UInt32),
            quality_score Nullable(Float32),
            created_at DateTime DEFAULT now(),
            updated_at DateTime DEFAULT now()
        )
        ENGINE = ReplacingMergeTree(updated_at)
        ORDER BY (exchange, symbol, date)
      `,
    })
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

  it('has expected schema', async () => {
    const columns = await fetchColumns('download_tasks')
    expect(columns.length).toBeGreaterThan(0)
    assertSchema(expectedColumns, columns)
  })

  it('inserts and lists pending tasks', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackDownloadTaskExchange(`task_${runId}`)
    const row: DownloadTaskRow = {
      exchange,
      symbol: `SYM_${runId}`,
      date: '2026-01-01',
      status: 'pending',
      error_message: null,
      file_size_bytes: null,
      rows_written: null,
      quality_score: null,
      created_at: toClickHouseDateTime(new Date()),
      updated_at: toClickHouseDateTime(new Date()),
    }

    await insertDownloadTasks([row])

    const pending = await listPendingTasks(exchange)
    expect(pending.some(task => task.symbol === row.symbol && task.date === row.date)).toBe(true)
  })

  it('updates task status and lists failed tasks', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackDownloadTaskExchange(`status_${runId}`)
    const symbol = `SYM_${runId}`
    const date = '2026-01-02'

    await insertDownloadTasks([
      {
        exchange,
        symbol,
        date,
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
    ])

    await updateTaskStatus(exchange, symbol, date, 'processing')
    await updateTaskStatus(exchange, symbol, date, 'failed', {
      error_message: 'parse error',
    })

    const failed = await listFailedTasks(exchange)
    const match = failed.find(task => task.symbol === symbol && task.date === date)

    expect(match).toBeTruthy()
    expect(match?.status).toBe('failed')
    expect(match?.error_message).toBe('parse error')
  })

  it('forces strictly increasing updated_at for rapid status transitions', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackDownloadTaskExchange(`monotonic_${runId}`)
    const symbol = `SYM_${runId}`
    const date = '2026-01-05'
    const fixedNow = Date.parse('2026-01-05T12:00:00.000Z')

    await insertDownloadTasks([
      {
        exchange,
        symbol,
        date,
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
    ])

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow)
    try {
      await updateTaskStatus(exchange, symbol, date, 'processing')
      await updateTaskStatus(exchange, symbol, date, 'completed', { rows_written: 10 })
    } finally {
      nowSpy.mockRestore()
    }

    const client = getClickHouseClient()
    const result = await client.query({
      query:
        'SELECT status, updated_at FROM download_tasks WHERE exchange = {exchange: String} AND symbol = {symbol: String} AND date = {date: Date} ORDER BY updated_at ASC',
      query_params: { exchange, symbol, date },
      format: 'JSONEachRow',
    })
    const rows = await result.json<{ status: DownloadTaskRow['status']; updated_at: string }>()

    const processing = rows.find(row => row.status === 'processing')
    const completed = rows.find(row => row.status === 'completed')

    expect(processing).toBeTruthy()
    expect(completed).toBeTruthy()
    if (!processing || !completed) {
      throw new Error('Expected processing and completed rows')
    }

    const processingMs = Date.parse(processing.updated_at.replace(' ', 'T') + 'Z')
    const completedMs = Date.parse(completed.updated_at.replace(' ', 'T') + 'Z')
    expect(completedMs).toBeGreaterThan(processingMs)
  })

  it('deduplicates duplicate rows in a single insert batch', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackDownloadTaskExchange(`dedup_${runId}`)
    const row: DownloadTaskRow = {
      exchange,
      symbol: `SYM_${runId}`,
      date: '2026-01-03',
      status: 'pending',
      error_message: null,
      file_size_bytes: null,
      rows_written: null,
      quality_score: null,
      updated_at: toClickHouseDateTime(new Date()),
    }

    await insertDownloadTasks([row, row, row])

    const pending = await listPendingTasks(exchange)
    const matches = pending.filter(task => task.symbol === row.symbol && task.date === row.date)
    expect(matches).toHaveLength(1)
  })

  it('hash partitioning: non-overlapping, complete coverage', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchanges = ['ex1', 'ex2', 'ex3', 'ex4'].map(e => trackDownloadTaskExchange(`${e}_${runId}`))
    const symbols = ['SYM_A', 'SYM_B', 'SYM_C', 'SYM_D', 'SYM_E']
    const date = '2026-03-01'

    const rows: DownloadTaskRow[] = []
    for (const exchange of exchanges) {
      for (const symbol of symbols) {
        rows.push({
          exchange,
          symbol,
          date,
          status: 'pending',
          error_message: null,
          file_size_bytes: null,
          rows_written: null,
          quality_score: null,
        })
      }
    }
    await insertDownloadTasks(rows)

    const [p0, p1, p2] = await Promise.all([
      listPendingTasks(undefined, undefined, 0, 3),
      listPendingTasks(undefined, undefined, 1, 3),
      listPendingTasks(undefined, undefined, 2, 3),
    ])

    const exchangeSet = new Set(exchanges)
    const filter = (tasks: DownloadTaskRow[]) => tasks.filter(t => exchangeSet.has(t.exchange))
    const f0 = filter(p0)
    const f1 = filter(p1)
    const f2 = filter(p2)

    const all = [...f0, ...f1, ...f2]
    const keys = all.map(t => `${t.exchange}:${t.symbol}:${t.date}`)
    expect(new Set(keys).size).toBe(20)
    expect(keys.length).toBe(20)
    expect(f0.length).toBeGreaterThan(0)
    expect(f1.length).toBeGreaterThan(0)
    expect(f2.length).toBeGreaterThan(0)
  })

  it('hash partitioning: deterministic across calls', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackDownloadTaskExchange(`det_${runId}`)
    const rows: DownloadTaskRow[] = ['A', 'B', 'C', 'D', 'E'].map(s => ({
      exchange,
      symbol: `SYM_${s}`,
      date: '2026-03-02',
      status: 'pending' as const,
      error_message: null,
      file_size_bytes: null,
      rows_written: null,
      quality_score: null,
    }))
    await insertDownloadTasks(rows)

    const first = await listPendingTasks(exchange, undefined, 1, 3)
    const second = await listPendingTasks(exchange, undefined, 1, 3)
    expect(first.map(t => t.symbol)).toEqual(second.map(t => t.symbol))
  })

  it('hash partitioning: single worker gets all tasks', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackDownloadTaskExchange(`single_${runId}`)
    const rows: DownloadTaskRow[] = ['A', 'B', 'C', 'D', 'E'].map(s => ({
      exchange,
      symbol: `SYM_${s}`,
      date: '2026-03-03',
      status: 'pending' as const,
      error_message: null,
      file_size_bytes: null,
      rows_written: null,
      quality_score: null,
    }))
    await insertDownloadTasks(rows)

    const partitioned = await listPendingTasks(exchange, undefined, 0, 1)
    const plain = await listPendingTasks(exchange)
    expect(partitioned.length).toBe(plain.length)
  })

  it('hash partitioning: only returns pending tasks, not completed/failed', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackDownloadTaskExchange(`status_filter_${runId}`)
    const date = '2026-03-04'

    await insertDownloadTasks([
      {
        exchange,
        symbol: 'SYM_P1',
        date,
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange,
        symbol: 'SYM_P2',
        date,
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange,
        symbol: 'SYM_P3',
        date,
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange,
        symbol: 'SYM_C',
        date,
        status: 'completed',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange,
        symbol: 'SYM_F',
        date,
        status: 'failed',
        error_message: 'x',
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
    ])

    const [p0, p1] = await Promise.all([
      listPendingTasks(exchange, undefined, 0, 2),
      listPendingTasks(exchange, undefined, 1, 2),
    ])

    const all = [...p0, ...p1]
    expect(all.every(t => t.status === 'pending')).toBe(true)
    expect(all.length).toBe(3)
  })

  it('hash partitioning: works with exchange filter', async () => {
    const runId = randomUUID().slice(0, 8)
    const exA = trackDownloadTaskExchange(`exchA_${runId}`)
    const exB = trackDownloadTaskExchange(`exchB_${runId}`)
    const date = '2026-03-05'

    await insertDownloadTasks([
      {
        exchange: exA,
        symbol: 'SYM_1',
        date,
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange: exA,
        symbol: 'SYM_2',
        date,
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange: exB,
        symbol: 'SYM_3',
        date,
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
    ])

    const [p0, p1] = await Promise.all([listPendingTasks(exA, undefined, 0, 2), listPendingTasks(exA, undefined, 1, 2)])

    const all = [...p0, ...p1]
    expect(all.every(t => t.exchange === exA)).toBe(true)
    expect(all.length).toBe(2)
  })

  it('hash partitioning: works with limit', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackDownloadTaskExchange(`limit_${runId}`)
    const date = '2026-03-06'

    await insertDownloadTasks(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map(s => ({
        exchange,
        symbol: `SYM_${s}`,
        date,
        status: 'pending' as const,
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      }))
    )

    const result = await listPendingTasks(exchange, 2, 0, 2)
    expect(result.length).toBeLessThanOrEqual(2)
    expect(result.every(t => t.exchange === exchange)).toBe(true)
  })

  it('stale recovery: resets downloading tasks older than threshold', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackDownloadTaskExchange(`stale_reset_${runId}`)
    const symbol = `SYM_${runId}`
    const date = '2026-03-07'
    const twoHoursAgo = toClickHouseDateTime(new Date(Date.now() - 7_200_000))

    await insertDownloadTasks([
      {
        exchange,
        symbol,
        date,
        status: 'downloading',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
        created_at: twoHoursAgo,
        updated_at: twoHoursAgo,
      },
    ])

    const count = await resetStaleTasks(60)
    expect(count).toBeGreaterThan(0)

    const pending = await listPendingTasks(exchange)
    const task = pending.find(t => t.symbol === symbol && t.date === date)
    expect(task).toBeTruthy()
    expect(task?.status).toBe('pending')
    expect(task?.error_message).toMatch(/Reset: stale/)
  })

  it('stale recovery: does NOT reset recent downloading tasks', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackDownloadTaskExchange(`stale_keep_${runId}`)
    const symbol = `SYM_${runId}`
    const date = '2026-03-08'

    await insertDownloadTasks([
      {
        exchange,
        symbol,
        date,
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
    ])
    await updateTaskStatus(exchange, symbol, date, 'downloading')

    await resetStaleTasks(60)

    const client = getClickHouseClient()
    const result = await client.query({
      query: `SELECT status FROM download_tasks FINAL WHERE exchange = {exchange: String} AND symbol = {symbol: String} AND date = {date: Date}`,
      query_params: { exchange, symbol, date },
      format: 'JSONEachRow',
    })
    const rows = await result.json<{ status: string }>()
    expect(rows[0]?.status).toBe('downloading')
  })

  it('stale recovery: does NOT touch completed/failed/pending tasks', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackDownloadTaskExchange(`stale_skip_${runId}`)
    const date = '2026-03-09'

    await insertDownloadTasks([
      {
        exchange,
        symbol: 'SYM_COMPLETED',
        date,
        status: 'completed',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange,
        symbol: 'SYM_FAILED',
        date,
        status: 'failed',
        error_message: 'err',
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange,
        symbol: 'SYM_PENDING',
        date,
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
    ])

    await resetStaleTasks(0)

    const client = getClickHouseClient()
    const result = await client.query({
      query: `SELECT symbol, status FROM download_tasks FINAL WHERE exchange = {exchange: String} AND date = {date: Date}`,
      query_params: { exchange, date },
      format: 'JSONEachRow',
    })
    const rows = await result.json<{ symbol: string; status: string }>()
    const bySymbol = Object.fromEntries(rows.map(r => [r.symbol, r.status]))
    expect(bySymbol.SYM_COMPLETED).toBe('completed')
    expect(bySymbol.SYM_FAILED).toBe('failed')
    expect(bySymbol.SYM_PENDING).toBe('pending')
  })

  it('stale recovery: returns correct count', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackDownloadTaskExchange(`stale_count_${runId}`)
    const date = '2026-03-10'
    const twoHoursAgo = toClickHouseDateTime(new Date(Date.now() - 7_200_000))

    await insertDownloadTasks([
      {
        exchange,
        symbol: 'SYM_D1',
        date,
        status: 'downloading',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
        created_at: twoHoursAgo,
        updated_at: twoHoursAgo,
      },
      {
        exchange,
        symbol: 'SYM_D2',
        date,
        status: 'processing',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
        created_at: twoHoursAgo,
        updated_at: twoHoursAgo,
      },
      {
        exchange,
        symbol: 'SYM_P1',
        date,
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
    ])

    const count = await resetStaleTasks(60)
    expect(count).toBe(2)
  })

  it('counts tasks grouped by status', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackDownloadTaskExchange(`count_${runId}`)

    await insertDownloadTasks([
      {
        exchange,
        symbol: `SYM_A_${runId}`,
        date: '2026-01-04',
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange,
        symbol: `SYM_B_${runId}`,
        date: '2026-01-04',
        status: 'failed',
        error_message: 'x',
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
    ])

    const counts = await countTasksByStatus(exchange)

    expect(counts.pending).toBe(1)
    expect(counts.failed).toBe(1)
  })

  it('reports per-exchange progress from latest task versions', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchangeA = trackDownloadTaskExchange(`progress_a_${runId}`)
    const exchangeB = trackDownloadTaskExchange(`progress_b_${runId}`)

    await insertDownloadTasks([
      {
        exchange: exchangeA,
        symbol: `A_DONE_${runId}`,
        date: '2026-01-06',
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange: exchangeA,
        symbol: `A_FAIL_1_${runId}`,
        date: '2026-01-06',
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange: exchangeA,
        symbol: `A_FAIL_2_${runId}`,
        date: '2026-01-06',
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange: exchangeA,
        symbol: `A_PENDING_${runId}`,
        date: '2026-01-06',
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange: exchangeA,
        symbol: `A_DOWN_${runId}`,
        date: '2026-01-06',
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange: exchangeA,
        symbol: `A_PROC_${runId}`,
        date: '2026-01-06',
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange: exchangeB,
        symbol: `B_DONE_${runId}`,
        date: '2026-01-06',
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange: exchangeB,
        symbol: `B_PENDING_${runId}`,
        date: '2026-01-06',
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
    ])

    await updateTaskStatus(exchangeA, `A_DONE_${runId}`, '2026-01-06', 'downloading')
    await updateTaskStatus(exchangeA, `A_DONE_${runId}`, '2026-01-06', 'processing')
    await updateTaskStatus(exchangeA, `A_DONE_${runId}`, '2026-01-06', 'completed', { rows_written: 10 })
    await updateTaskStatus(exchangeA, `A_FAIL_1_${runId}`, '2026-01-06', 'failed', { error_message: 'parse error' })
    await updateTaskStatus(exchangeA, `A_FAIL_2_${runId}`, '2026-01-06', 'downloading')
    await updateTaskStatus(exchangeA, `A_FAIL_2_${runId}`, '2026-01-06', 'failed', { error_message: 'parse error' })
    await updateTaskStatus(exchangeA, `A_DOWN_${runId}`, '2026-01-06', 'downloading')
    await updateTaskStatus(exchangeA, `A_PROC_${runId}`, '2026-01-06', 'processing')
    await updateTaskStatus(exchangeB, `B_DONE_${runId}`, '2026-01-06', 'completed', { rows_written: 12 })

    const progress = await listExchangeTaskProgress()

    const rowA = progress.find(row => row.exchange === exchangeA)
    const rowB = progress.find(row => row.exchange === exchangeB)

    expect(rowA).toEqual({
      exchange: exchangeA,
      completed_tasks: 1,
      pending_tasks: 3,
      failed_tasks: 2,
      error_breakdown: [['parse error', 2]],
    })
    expect(rowB).toEqual({
      exchange: exchangeB,
      completed_tasks: 1,
      pending_tasks: 1,
      failed_tasks: 0,
      error_breakdown: [],
    })

    const totalLatestTasks = progress.reduce(
      (sum, row) => sum + row.completed_tasks + row.pending_tasks + row.failed_tasks,
      0
    )
    expect(totalLatestTasks).toBe(8)
  })

  it('excludes blank failure messages and non-latest failures from error breakdowns', async () => {
    const runId = randomUUID().slice(0, 8)
    const exchange = trackDownloadTaskExchange(`errors_${runId}`)

    await insertDownloadTasks([
      {
        exchange,
        symbol: `DONE_${runId}`,
        date: '2026-01-07',
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange,
        symbol: `BLANK_${runId}`,
        date: '2026-01-07',
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
      {
        exchange,
        symbol: `NULL_${runId}`,
        date: '2026-01-07',
        status: 'pending',
        error_message: null,
        file_size_bytes: null,
        rows_written: null,
        quality_score: null,
      },
    ])

    await updateTaskStatus(exchange, `DONE_${runId}`, '2026-01-07', 'failed', { error_message: 'transient error' })
    await updateTaskStatus(exchange, `DONE_${runId}`, '2026-01-07', 'completed', { rows_written: 20 })
    await updateTaskStatus(exchange, `BLANK_${runId}`, '2026-01-07', 'failed', { error_message: '' })
    await updateTaskStatus(exchange, `NULL_${runId}`, '2026-01-07', 'failed', { error_message: null })

    const progress = await listExchangeTaskProgress()
    const row = progress.find(result => result.exchange === exchange)

    expect(row).toEqual({
      exchange,
      completed_tasks: 1,
      pending_tasks: 0,
      failed_tasks: 2,
      error_breakdown: [],
    })
  })
})
