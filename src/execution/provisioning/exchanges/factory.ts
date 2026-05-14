import { EXCHANGE_CAPABILITIES } from '../capabilities.js'
import { BinanceProvisioningAdapter } from './binance.js'
import { BitgetProvisioningAdapter } from './bitget.js'
import { BybitProvisioningAdapter } from './bybit.js'
import { GateioProvisioningAdapter } from './gateio.js'
import { KucoinProvisioningAdapter } from './kucoin.js'
import { MexcProvisioningAdapter } from './mexc.js'
import { OkxProvisioningAdapter } from './okx.js'
import type { ProvisioningAdapter } from './types.js'
import { loadMasterCredentials } from './types.js'

export function buildAdapter(exchange: string, label: string): ProvisioningAdapter {
  if (!(exchange in EXCHANGE_CAPABILITIES)) {
    throw new Error(`Unknown exchange: ${exchange}. Valid exchanges: ${Object.keys(EXCHANGE_CAPABILITIES).join(', ')}`)
  }
  const caps = EXCHANGE_CAPABILITIES[exchange as keyof typeof EXCHANGE_CAPABILITIES]

  const creds = loadMasterCredentials(caps.exchange)

  switch (exchange) {
    case 'binance':
      return new BinanceProvisioningAdapter(creds)
    case 'bybit':
      return new BybitProvisioningAdapter(creds)
    case 'mexc':
      return new MexcProvisioningAdapter(creds)
    case 'bitget':
      return new BitgetProvisioningAdapter(creds, label)
    case 'kucoin':
      return new KucoinProvisioningAdapter(creds, label)
    case 'okx':
      return new OkxProvisioningAdapter(creds)
    case 'gateio':
      return new GateioProvisioningAdapter(creds)
    default:
      throw new Error(`No full_api adapter implemented for: ${exchange}`)
  }
}
