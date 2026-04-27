import type { CcxtMarket } from '../../exchanges/types.js'

export interface MockExchangeSetup {
  markets?: Record<string, CcxtMarket>
  error?: Error
}

export function makePerpMarket(id: string, symbol: string, overrides: Record<string, unknown> = {}): CcxtMarket {
  return {
    id,
    symbol,
    swap: true,
    linear: true,
    settle: 'USDT',
    active: true,
    contractSize: 1,
    maker: 0.0001,
    taker: 0.0005,
    precision: { price: 2, amount: 3 },
    limits: {
      price: { min: 0.01, max: 1000000 },
      amount: { min: 0.001, max: 10000 },
      cost: { min: 5 },
    },
    info: { maxLeverage: 125 },
    ...overrides,
  }
}

export function makeBtcPerp(overrides: Record<string, unknown> = {}): CcxtMarket {
  return makePerpMarket('BTCUSDT', 'BTC/USDT:USDT', overrides)
}

export function makeEthPerp(overrides: Record<string, unknown> = {}): CcxtMarket {
  return makePerpMarket('ETHUSDT', 'ETH/USDT:USDT', {
    info: { maxLeverage: 100 },
    ...overrides,
  })
}
