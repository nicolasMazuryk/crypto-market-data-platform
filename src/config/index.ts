import { parseDateEnv, parseIntEnv, requireEnv } from './env.js'
import type { ExchangeConfig } from '../exchanges/types.js'

const dataPeriodStart = parseDateEnv('DATA_PERIOD_START', { required: true })
if (!dataPeriodStart) {
  throw new Error('Missing required environment variable: DATA_PERIOD_START')
}

export const DATA_PERIOD_START = dataPeriodStart
export const DATA_PERIOD_END = parseDateEnv('DATA_PERIOD_END')

export const FUNDING_RATE_MAX_RETRIES = parseIntEnv('FUNDING_RATE_MAX_RETRIES')
export const FUNDING_RATE_BACKOFF_BASE_MS = parseIntEnv('FUNDING_RATE_BACKOFF_BASE_MS')
export const FUNDING_RATE_BACKOFF_MAX_MS = parseIntEnv('FUNDING_RATE_BACKOFF_MAX_MS')
export const FUNDING_RATE_PAGE_SIZE = parseIntEnv('FUNDING_RATE_PAGE_SIZE')
export const FUNDING_RATE_SYMBOL_CONCURRENCY = parseIntEnv('FUNDING_RATE_SYMBOL_CONCURRENCY')

export const EXCHANGE_CONFIGS: ExchangeConfig[] = [
  { name: 'binance', ccxtId: 'binanceusdm' },
  { name: 'bybit', ccxtId: 'bybit', options: { defaultType: 'swap' } },
  { name: 'okx', ccxtId: 'okx', options: { defaultType: 'swap' } },
  { name: 'mexc', ccxtId: 'mexc', options: { defaultType: 'swap' } },
  { name: 'bitget', ccxtId: 'bitget', options: { defaultType: 'swap' } },
  { name: 'gateio', ccxtId: 'gateio', options: { defaultType: 'swap' } },
  { name: 'kucoin', ccxtId: 'kucoinfutures' },
]

export const DELISTINGS_DIR = requireEnv('DELISTINGS_DIR')
export const MIGRATIONS_DIR = requireEnv('MIGRATIONS_DIR')
