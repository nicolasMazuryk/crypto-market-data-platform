import { clickhouseHost } from '../clickhouse'

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}

export function workerEnvironment() {
  const environment = {
    NODE_ENV: 'production',
    LOG_LEVEL: requireEnv('WORKER_LOG_LEVEL'),
    CLICKHOUSE_HOST: clickhouseHost,
    CLICKHOUSE_HTTP_PORT: requireEnv('CLICKHOUSE_HTTP_PORT'),
    CLICKHOUSE_NATIVE_PORT: requireEnv('CLICKHOUSE_NATIVE_PORT'),
    CLICKHOUSE_DATABASE: requireEnv('CLICKHOUSE_DATABASE'),
    CLICKHOUSE_USER: requireEnv('CLICKHOUSE_USER'),
    CLICKHOUSE_PASSWORD: requireEnv('CLICKHOUSE_PASSWORD'),
    DELISTINGS_DIR: requireEnv('DELISTINGS_DIR'),
    MIGRATIONS_DIR: requireEnv('MIGRATIONS_DIR'),
    DATA_PERIOD_START: requireEnv('DATA_PERIOD_START'),
    FUNDING_RATE_MAX_RETRIES: requireEnv('FUNDING_RATE_MAX_RETRIES'),
    FUNDING_RATE_BACKOFF_BASE_MS: requireEnv('FUNDING_RATE_BACKOFF_BASE_MS'),
    FUNDING_RATE_BACKOFF_MAX_MS: requireEnv('FUNDING_RATE_BACKOFF_MAX_MS'),
    FUNDING_RATE_PAGE_SIZE: requireEnv('FUNDING_RATE_PAGE_SIZE'),
    FUNDING_RATE_SYMBOL_CONCURRENCY: requireEnv(
      'FUNDING_RATE_SYMBOL_CONCURRENCY'
    ),
  }

  if (process.env.DATA_PERIOD_END) {
    return {
      ...environment,
      DATA_PERIOD_END: process.env.DATA_PERIOD_END,
    }
  }

  return environment
}
