import { parseDateEnv, parseIntEnv } from './env.js'
import type { ExchangeConfig } from '../exchanges/types.js'

const parsedStart = parseDateEnv('DATA_PERIOD_START', { required: true })
if (!parsedStart) {
  throw new Error('DATA_PERIOD_START is required')
}

export const DATA_PERIOD_START = parsedStart
export const DATA_PERIOD_END = parseDateEnv('DATA_PERIOD_END')

export const FUNDING_RATE_MAX_RETRIES = parseIntEnv(
  'FUNDING_RATE_MAX_RETRIES'
)
export const FUNDING_RATE_BACKOFF_BASE_MS = parseIntEnv(
  'FUNDING_RATE_BACKOFF_BASE_MS'
)
export const FUNDING_RATE_BACKOFF_MAX_MS = parseIntEnv(
  'FUNDING_RATE_BACKOFF_MAX_MS'
)
export const FUNDING_RATE_PAGE_SIZE = parseIntEnv(
  'FUNDING_RATE_PAGE_SIZE'
)
export const FUNDING_RATE_MAX_PAGES = parseIntEnv(
  'FUNDING_RATE_MAX_PAGES'
)
export const EXCHANGE_SYNC_CONCURRENCY = parseIntEnv(
  'EXCHANGE_SYNC_CONCURRENCY'
)
export const FUNDING_RATE_SYMBOL_CONCURRENCY = parseIntEnv(
  'FUNDING_RATE_SYMBOL_CONCURRENCY'
)

export const EXCHANGE_CONFIGS: ExchangeConfig[] = [
  { name: 'binance', ccxtId: 'binanceusdm' },
  { name: 'bybit', ccxtId: 'bybit', options: { defaultType: 'swap' } },
  { name: 'okx', ccxtId: 'okx', options: { defaultType: 'swap' } },
  { name: 'mexc', ccxtId: 'mexc', options: { defaultType: 'swap' } },
  { name: 'bitget', ccxtId: 'bitget', options: { defaultType: 'swap' } },
  { name: 'gateio', ccxtId: 'gateio', options: { defaultType: 'swap' } },
  { name: 'kucoin', ccxtId: 'kucoinfutures' }
]

export const DELISTINGS_DIR = 'src/markets/delistings'
