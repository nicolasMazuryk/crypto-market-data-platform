import type { Exchange } from '../types/exchange.js'

export const ccxtIdMap: Record<Exchange, string> = {
  binance: 'binanceusdm',
  bitget: 'bitget',
  bybit: 'bybit',
  okx: 'okx',
  gateio: 'gateio',
  kucoin: 'kucoinfutures',
}
