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

export type ErrorBreakdownEntry = [errorMessage: string, occurrences: number]

export interface ExchangeTaskProgressRow {
  exchange: string
  completed_tasks: number
  pending_tasks: number
  failed_tasks: number
  error_breakdown: ErrorBreakdownEntry[]
}

interface RawExchangeTaskProgressRow {
  exchange: string
  completed_tasks: string | number
  pending_tasks: string | number
  failed_tasks: string | number
  error_breakdown: unknown
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

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value)
}

function toErrorMessage(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }

  return null
}

function normalizeErrorBreakdown(value: unknown): ErrorBreakdownEntry[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap(entry => {
    if (Array.isArray(entry) && entry.length >= 2) {
      return [[String(entry[0]), toNumber(entry[1] as string | number)]]
    }

    if (entry && typeof entry === 'object') {
      const tuple = entry as {
        error_message?: unknown
        occurrences?: unknown
        1?: unknown
        2?: unknown
      }
      const errorMessage = tuple.error_message ?? tuple[1]
      const occurrences = tuple.occurrences ?? tuple[2]
      const normalizedErrorMessage = toErrorMessage(errorMessage)

      if (normalizedErrorMessage !== null && occurrences !== undefined) {
        return [[normalizedErrorMessage, toNumber(occurrences as string | number)]]
      }
    }

    return []
  })
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

export async function listExchangeTaskProgress(): Promise<ExchangeTaskProgressRow[]> {
  const client = getClickHouseClient()
  const result = await client.query({
    query: `
      WITH latest_tasks AS (
          SELECT
              exchange,
              symbol,
              date,
              argMax(status, updated_at) AS status,
              argMax(error_message, updated_at) AS error_message
          FROM download_tasks
          GROUP BY exchange, symbol, date
      ),
      error_counts AS (
          SELECT
              exchange,
              error_message,
              count() AS occurrences
          FROM latest_tasks
          WHERE status = 'failed'
            AND error_message IS NOT NULL
            AND error_message != ''
          GROUP BY exchange, error_message
      ),
      errors_by_exchange AS (
          SELECT
              exchange,
              arraySort(item -> item.1, groupArray((error_message, occurrences))) AS error_breakdown
          FROM error_counts
          GROUP BY exchange
      )
      SELECT
          t.exchange,
          countIf(t.status = 'completed') AS completed_tasks,
          countIf(t.status IN ('pending', 'downloading', 'processing')) AS pending_tasks,
          countIf(t.status = 'failed') AS failed_tasks,
          ifNull(e.error_breakdown, []) AS error_breakdown
      FROM latest_tasks AS t
      LEFT JOIN errors_by_exchange AS e USING (exchange)
      GROUP BY t.exchange, e.error_breakdown
      ORDER BY t.exchange
    `,
    format: 'JSONEachRow',
  })

  const rows = await result.json<RawExchangeTaskProgressRow>()
  return rows.map(row => ({
    exchange: row.exchange,
    completed_tasks: toNumber(row.completed_tasks),
    pending_tasks: toNumber(row.pending_tasks),
    failed_tasks: toNumber(row.failed_tasks),
    error_breakdown: normalizeErrorBreakdown(row.error_breakdown),
  }))
}
