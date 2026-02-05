import type { ExchangeConfig } from '../exchanges/types.js'

export const DATA_PERIOD_START = new Date(Date.UTC(2025, 0, 1))
export const DATA_PERIOD_END: Date | null = null

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
export const MARKETS_OUTPUT_DIR = 'src/markets/snapshots'
