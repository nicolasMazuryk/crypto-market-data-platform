import { logger } from '../../logger.js'
import { getClickHouseClient } from '../client.js'
import { toClickHouseDateTime, type DownloadTaskRow } from '../types.js'

const DOWNLOAD_TASK_COLUMNS =
  'exchange, symbol, date, status, error_message, file_size_bytes, rows_written, quality_score, created_at, updated_at'

export interface DownloadTaskUpdateFields {
  error_message?: string | null
  file_size_bytes?: number | null
  rows_written?: number | null
  quality_score?: number | null
}

export interface TaskStatusCounts {
  pending: number
  downloading: number
  processing: number
  completed: number
  failed: number
}

function hasOwn(fields: DownloadTaskUpdateFields, key: keyof DownloadTaskUpdateFields): boolean {
  return Object.prototype.hasOwnProperty.call(fields, key)
}

function parseClickHouseDateTime(value: string | undefined): number | null {
  if (!value) {
    return null
  }

  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const parsed = Date.parse(normalized)
  return Number.isNaN(parsed) ? null : parsed
}

function nextUpdatedAt(existing: DownloadTaskRow | null): string {
  const nowMs = Date.now()
  const previousUpdatedAtMs = parseClickHouseDateTime(existing?.updated_at)
  const effectiveMs = previousUpdatedAtMs === null ? nowMs : Math.max(nowMs, previousUpdatedAtMs + 1000)

  return toClickHouseDateTime(new Date(effectiveMs))
}

async function getTaskByExchangeSymbolDate(
  exchange: string,
  symbol: string,
  date: string,
  useFinal = true
): Promise<DownloadTaskRow | null> {
  const client = getClickHouseClient()
  const finalClause = useFinal ? ' FINAL' : ''
  const result = await client.query({
    query: `SELECT ${DOWNLOAD_TASK_COLUMNS} FROM download_tasks${finalClause} WHERE exchange = {exchange: String} AND symbol = {symbol: String} AND date = {date: Date} LIMIT 1`,
    query_params: { exchange, symbol, date },
    format: 'JSONEachRow',
  })

  const rows = await result.json<DownloadTaskRow>()
  return rows[0] ?? null
}

export async function insertDownloadTasks(rows: DownloadTaskRow[]): Promise<void> {
  if (rows.length === 0) {
    return
  }

  const seen = new Map<string, DownloadTaskRow>()

  for (const row of rows) {
    const key = `${row.exchange}:${row.symbol}:${row.date}`
    const existing = seen.get(key)

    if (!existing) {
      seen.set(key, row)
      continue
    }

    const currentTime = row.updated_at ?? row.created_at ?? new Date().toISOString()
    const existingTime = existing.updated_at ?? existing.created_at ?? new Date().toISOString()

    if (currentTime > existingTime) {
      seen.set(key, row)
      logger.warn(
        {
          exchange: row.exchange,
          symbol: row.symbol,
          date: row.date,
        },
        'Replacing duplicate download task in batch with newer version'
      )
    }
  }

  const uniqueRows = Array.from(seen.values())
  const client = getClickHouseClient()
  await client.insert({
    table: 'download_tasks',
    values: uniqueRows,
    format: 'JSONEachRow',
  })
}

export async function deleteDownloadTasksByExchange(exchange: string): Promise<void> {
  const client = getClickHouseClient()
  await client.command({
    query: 'ALTER TABLE download_tasks DELETE WHERE exchange = {exchange: String}',
    query_params: { exchange },
    clickhouse_settings: {
      mutations_sync: '1',
    },
  })
}

export async function listPendingTasks(
  exchange?: string,
  limit?: number,
  workerIndex?: number,
  workerCount?: number
): Promise<DownloadTaskRow[]> {
  const client = getClickHouseClient()
  const usePartition = workerCount !== undefined && workerCount > 1
  const partitionClause = usePartition
    ? ' AND cityHash64(exchange, symbol, toString(date)) % {workerCount: UInt32} = {workerIndex: UInt32}'
    : ''
  const result = await client.query({
    query: `SELECT ${DOWNLOAD_TASK_COLUMNS} FROM download_tasks FINAL WHERE status = 'pending'${exchange ? ' AND exchange = {exchange: String}' : ''}${partitionClause} ORDER BY exchange ASC, symbol ASC, date ASC${limit !== undefined ? ' LIMIT {limit: UInt32}' : ''}`,
    ...(() => {
      const queryParams: Record<string, unknown> = {}
      if (exchange) {
        queryParams.exchange = exchange
      }

      if (limit !== undefined) {
        queryParams.limit = limit
      }

      if (usePartition) {
        queryParams.workerCount = workerCount
        queryParams.workerIndex = workerIndex ?? 0
      }

      return Object.keys(queryParams).length > 0 ? { query_params: queryParams } : {}
    })(),
    format: 'JSONEachRow',
  })

  return result.json<DownloadTaskRow>()
}

export async function resetStaleTasks(staleMinutes: number): Promise<number> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: `SELECT ${DOWNLOAD_TASK_COLUMNS} FROM download_tasks FINAL WHERE status IN ('downloading', 'processing') AND updated_at < now() - INTERVAL {staleMinutes: UInt32} MINUTE`,
    query_params: { staleMinutes },
    format: 'JSONEachRow',
  })

  const staleTasks = await result.json<DownloadTaskRow>()
  for (const task of staleTasks) {
    await updateTaskStatus(task.exchange, task.symbol, task.date, 'pending', {
      error_message: `Reset: stale after ${String(staleMinutes)} minutes`,
    })
  }

  return staleTasks.length
}

export async function listFailedTasks(exchange?: string): Promise<DownloadTaskRow[]> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: `SELECT ${DOWNLOAD_TASK_COLUMNS} FROM download_tasks FINAL WHERE status = 'failed'${exchange ? ' AND exchange = {exchange: String}' : ''} ORDER BY exchange ASC, symbol ASC, date ASC`,
    ...(exchange ? { query_params: { exchange } } : {}),
    format: 'JSONEachRow',
  })

  return result.json<DownloadTaskRow>()
}

export async function updateTaskStatus(
  exchange: string,
  symbol: string,
  date: string,
  status: DownloadTaskRow['status'],
  fields: DownloadTaskUpdateFields = {}
): Promise<void> {
  const existing = await getTaskByExchangeSymbolDate(exchange, symbol, date)
  const now = nextUpdatedAt(existing)

  const row: DownloadTaskRow = {
    exchange,
    symbol,
    date,
    status,
    error_message: hasOwn(fields, 'error_message')
      ? (fields.error_message ?? null)
      : status === 'failed'
        ? (existing?.error_message ?? null)
        : null,
    file_size_bytes: hasOwn(fields, 'file_size_bytes')
      ? (fields.file_size_bytes ?? null)
      : (existing?.file_size_bytes ?? null),
    rows_written: hasOwn(fields, 'rows_written') ? (fields.rows_written ?? null) : (existing?.rows_written ?? null),
    quality_score: hasOwn(fields, 'quality_score') ? (fields.quality_score ?? null) : (existing?.quality_score ?? null),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  }

  const client = getClickHouseClient()
  await client.insert({
    table: 'download_tasks',
    values: [row],
    format: 'JSONEachRow',
  })
}

export async function optimizeDownloadTasksTable(): Promise<void> {
  const client = getClickHouseClient()
  await client.command({
    query: 'OPTIMIZE TABLE download_tasks FINAL',
  })
}

export async function listCompletedTaskKeys(): Promise<Set<string>> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: `SELECT exchange, symbol, toString(date) AS date FROM download_tasks FINAL WHERE status = 'completed'`,
    format: 'JSONEachRow',
  })

  const rows = await result.json<{ exchange: string; symbol: string; date: string }>()
  return new Set(rows.map(row => `${row.exchange}:${row.symbol}:${row.date}`))
}

export async function countTasksByStatus(exchange?: string): Promise<TaskStatusCounts> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: `SELECT status, count() as count FROM download_tasks FINAL${exchange ? ' WHERE exchange = {exchange: String}' : ''} GROUP BY status`,
    ...(exchange ? { query_params: { exchange } } : {}),
    format: 'JSONEachRow',
  })

  const rows = await result.json<{
    status: DownloadTaskRow['status']
    count: string | number
  }>()

  const counts: TaskStatusCounts = {
    pending: 0,
    downloading: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  }

  for (const row of rows) {
    counts[row.status] = Number(row.count)
  }

  return counts
}
