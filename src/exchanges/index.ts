import { EXCHANGE_CONFIGS } from '../config/index.js'
import type { ExchangeConfig, ExchangeName } from './types.js'

export { EXCHANGE_CONFIGS }

export const EXCHANGE_NAMES = EXCHANGE_CONFIGS.map((exchange) => exchange.name)

export function getExchangeConfig(
  name: ExchangeName
): ExchangeConfig | undefined {
  return EXCHANGE_CONFIGS.find((exchange) => exchange.name === name)
}
