import os from 'node:os'
import path from 'node:path'

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

function parseNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

export const DOWNLOAD_TEMP_DIR = path.resolve(
  process.env.DOWNLOAD_TEMP_DIR ?? path.join(os.tmpdir(), 'arbinet-downloads')
)
export const DOWNLOAD_MAX_RETRIES = parseInteger(process.env.DOWNLOAD_MAX_RETRIES, 5)
export const DOWNLOAD_BACKOFF_BASE_MS = parseInteger(process.env.DOWNLOAD_BACKOFF_BASE_MS, 1_000)
export const DOWNLOAD_BACKOFF_MAX_MS = parseInteger(process.env.DOWNLOAD_BACKOFF_MAX_MS, 30_000)
export const DOWNLOAD_TIMEOUT_MS = parseInteger(process.env.DOWNLOAD_TIMEOUT_MS, 300_000)
export const DOWNLOAD_SYMBOL_CONCURRENCY = parseInteger(process.env.DOWNLOAD_SYMBOL_CONCURRENCY, 3)
export const DOWNLOAD_FILE_CONCURRENCY = parseInteger(process.env.DOWNLOAD_FILE_CONCURRENCY, 8)
export const VALIDATION_CONCURRENCY = parseInteger(process.env.VALIDATION_CONCURRENCY, 16)
export const DOWNLOAD_STALE_AGE_MS = parseInteger(process.env.DOWNLOAD_STALE_AGE_MS, 7_200_000)
export const WORKER_INDEX = parseInteger(process.env.WORKER_INDEX, 0)
export const WORKER_COUNT = parseInteger(process.env.WORKER_COUNT, 1)
export const STALE_RECOVERY_MINUTES = parseInteger(process.env.STALE_RECOVERY_MINUTES, 60)
/** Restrict a sync run to a single exchange's pending tasks. Undefined = all exchanges. */
export const QUOTE_SYNC_EXCHANGE = parseNonEmpty(process.env.QUOTE_SYNC_EXCHANGE)
