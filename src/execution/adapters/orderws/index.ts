import type { ExchangeConfig, ExchangeCredentials } from '../../config/types.js'
import type { ExchangeOrderWsAdapter } from './types.js'
import { createBinanceOrderWsAdapter } from './binance.js'
import { createBybitOrderWsAdapter } from './bybit.js'
import { createOkxOrderWsAdapter } from './okx.js'
import { createGateioOrderWsAdapter } from './gateio.js'
import { createKucoinOrderWsAdapter } from './kucoin.js'
import { createBitgetOrderWsAdapter } from './bitget.js'

export type { ExchangeOrderWsAdapter } from './types.js'

export function createOrderWsAdapter(
  config: ExchangeConfig & { credentials?: ExchangeCredentials }
): ExchangeOrderWsAdapter {
  const { exchange, credentials, privateWsUrl: wsBaseUrl } = config
  const credOpts = credentials ? { credentials } : {}
  const wsOpts = wsBaseUrl ? { wsBaseUrl } : {}
  const opts = { ...credOpts, ...wsOpts }
  switch (exchange) {
    case 'binance':
      return createBinanceOrderWsAdapter(opts)
    case 'bybit':
      return createBybitOrderWsAdapter(opts)
    case 'okx':
      return createOkxOrderWsAdapter(opts)
    case 'gateio':
      return createGateioOrderWsAdapter(opts)
    case 'kucoin':
      return createKucoinOrderWsAdapter(opts)
    case 'bitget':
      return createBitgetOrderWsAdapter(opts)
    default:
      throw new Error(`No order WS adapter for exchange: ${exchange as string}`)
  }
}
