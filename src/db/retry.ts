import { closeClickHouseClient } from './client.js'

// Keep in sync with RETRYABLE_FAILURE_PATTERNS in src/autoresearch/backtest/runner.ts
const RETRYABLE_PATTERNS = [
  /\bECONNREFUSED\b/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bEPIPE\b/i,
  /\bECONNABORTED\b/i,
  /\bsocket hang up\b/i,
]

const BACKOFF_INITIAL_MS = 500
const BACKOFF_MAX_MS = 30_000
const MAX_CONSECUTIVE_RETRIES = 50

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return RETRYABLE_PATTERNS.some(p => p.test(msg))
}

function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_INITIAL_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function withClickHouseRetry<T>(
  fn: () => Promise<T>,
  opts?: { logPrefix?: string }
): Promise<T> {
  const prefix = opts?.logPrefix ?? '[clickhouse-retry]'
  let attempt = 0

  for (;;) {
    try {
      return await fn()
    } catch (err) {
      attempt++
      if (!isRetryable(err) || attempt > MAX_CONSECUTIVE_RETRIES) {
        throw err
      }
      const delay = backoffMs(attempt)
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`${prefix} retryable error (attempt ${String(attempt)}): ${msg}; retrying in ${String(delay)}ms\n`)
      await closeClickHouseClient()
      await sleep(delay)
    }
  }
}
