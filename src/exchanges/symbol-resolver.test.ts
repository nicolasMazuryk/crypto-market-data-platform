import { describe, it, expect } from 'vitest'

import type { Market } from './types.js'
import { createExchangeSymbolResolver } from './symbol-resolver.js'

describe('createExchangeSymbolResolver', () => {
  it('infers underscore formatting for MEXC symbols', () => {
    const activeMarkets: Market[] = [
      {
        exchange: 'mexc',
        symbol: '1000RATSUSDT',
        exchange_symbol: '1000RATS_USDT',
        type: 'perpetual',
        listing_date: null,
        delisting_date: null,
        is_active: true,
      },
      {
        exchange: 'mexc',
        symbol: 'BTCUSDT',
        exchange_symbol: 'BTC_USDT',
        type: 'perpetual',
        listing_date: null,
        delisting_date: null,
        is_active: true,
      },
    ]

    const resolver = createExchangeSymbolResolver('mexc', activeMarkets)

    expect(resolver.getExchangeSymbol('1000MUMUUSDT')).toBe('1000MUMU_USDT')
    expect(resolver.getExchangeSymbol('BTCUSDT')).toBe('BTC_USDT')
  })

  it('prefers active symbol mapping and applies dashed swap format for OKX', () => {
    const activeMarkets: Market[] = [
      {
        exchange: 'okx',
        symbol: 'ALGOUSDT',
        exchange_symbol: 'ALGO-USDT-SWAP',
        type: 'perpetual',
        listing_date: null,
        delisting_date: null,
        is_active: true,
      },
      {
        exchange: 'okx',
        symbol: 'BTCUSDT',
        exchange_symbol: 'BTC-USDT-SWAP',
        type: 'perpetual',
        listing_date: null,
        delisting_date: null,
        is_active: true,
      },
      {
        exchange: 'okx',
        symbol: 'ALCHUSDT',
        exchange_symbol: 'ALCHUSDT',
        type: 'perpetual',
        listing_date: null,
        delisting_date: null,
        is_active: true,
      },
    ]

    const resolver = createExchangeSymbolResolver('okx', activeMarkets)

    expect(resolver.getExchangeSymbol('0GUSDT')).toBe('0G-USDT-SWAP')
    expect(resolver.getExchangeSymbol('ALCHUSDT')).toBe('ALCHUSDT')
  })

  it('falls back to raw symbol when no format is available', () => {
    const resolver = createExchangeSymbolResolver('binance', [])

    expect(resolver.getExchangeSymbol('ETHUSDT', 'ETHUSDT')).toBe('ETHUSDT')
  })
})
