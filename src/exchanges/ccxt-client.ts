import ccxt from 'ccxt'

import type { CcxtExchange, ExchangeConfig } from './types.js'

type CcxtConstructor = new (config?: Record<string, unknown>) => CcxtExchange

export function createCcxtExchange(exchangeConfig: ExchangeConfig): CcxtExchange {
  const ccxtRegistry = ccxt as unknown as Record<string, CcxtConstructor>
  const ExchangeClass = ccxtRegistry[exchangeConfig.ccxtId]

  if (!ExchangeClass) {
    throw new Error(`Unsupported CCXT exchange id: ${exchangeConfig.ccxtId}`)
  }

  return new ExchangeClass({
    enableRateLimit: true,
    options: exchangeConfig.options ?? {},
  })
}
