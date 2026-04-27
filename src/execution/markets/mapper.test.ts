import { describe, expect, it } from 'vitest'

import type { CcxtMarket } from '../../exchanges/types.js'
import { makeBtcPerp, makeEthPerp, makePerpMarket } from '../test-helpers/ccxtMock.js'
import { mapCcxtMarket } from './mapper.js'

describe('mapCcxtMarket', () => {
  it('maps a BTC USDT perpetual to MarketMetadata', () => {
    const raw = makeBtcPerp()
    const result = mapCcxtMarket('binance', raw)

    expect(result).not.toBeNull()
    expect(result?.exchange).toBe('binance')
    expect(result?.symbol).toBe('BTCUSDT')
    expect(result?.exchangeSymbol).toBe('BTCUSDT')
    expect(result?.contractSize).toBe(1)
    expect(result?.pricePrecision).toBe(2)
    expect(result?.amountPrecision).toBe(3)
    expect(result?.makerFee).toBe(0.0001)
    expect(result?.takerFee).toBe(0.0005)
    expect(result?.status).toBe('trading')
    expect(result?.maxLeverage).toBe(125)
    expect(result?.minPrice).toBe(0.01)
    expect(result?.maxPrice).toBe(1000000)
    expect(result?.minAmount).toBe(0.001)
    expect(result?.maxAmount).toBe(10000)
    expect(result?.minCost).toBe(5)
  })

  it('returns null for inverse (non-linear) markets', () => {
    const raw = makeBtcPerp({ linear: false })
    expect(mapCcxtMarket('binance', raw)).toBeNull()
  })

  it('returns null for non-swap markets', () => {
    const raw = makeBtcPerp({ swap: false })
    expect(mapCcxtMarket('binance', raw)).toBeNull()
  })

  it('returns null for non-USDT-settled markets', () => {
    const raw = makePerpMarket('BTCUSDC', 'BTC/USDC:USDC', { settle: 'USDC' })
    expect(mapCcxtMarket('binance', raw)).toBeNull()
  })

  it('maps inactive market as halted (not filtered out)', () => {
    const raw = makeBtcPerp({ active: false })
    const result = mapCcxtMarket('binance', raw)

    expect(result).not.toBeNull()
    expect(result?.status).toBe('halted')
    expect(result?.symbol).toBe('BTCUSDT')
  })

  it('extracts maxLeverage from binance info.maxLeverage', () => {
    const raw = makeBtcPerp({ info: { maxLeverage: 125 } })
    expect(mapCcxtMarket('binance', raw)?.maxLeverage).toBe(125)
  })

  it('extracts maxLeverage from binance info.brackets[0].initialLeverage fallback', () => {
    const raw = makeBtcPerp({ info: { brackets: [{ initialLeverage: 75 }] } })
    expect(mapCcxtMarket('binance', raw)?.maxLeverage).toBe(75)
  })

  it('extracts maxLeverage from bitget info.maxLever (number)', () => {
    const raw = makeEthPerp({ info: { maxLever: 50 } })
    expect(mapCcxtMarket('bitget', raw)?.maxLeverage).toBe(50)
  })

  it('extracts maxLeverage from bitget info.maxLever (string)', () => {
    const raw = makeEthPerp({ info: { maxLever: '75' } })
    expect(mapCcxtMarket('bitget', raw)?.maxLeverage).toBe(75)
  })

  it('falls back to 0 for missing precision fields', () => {
    const raw = makeBtcPerp({ precision: {} })
    const result = mapCcxtMarket('binance', raw)
    expect(result?.pricePrecision).toBe(0)
    expect(result?.amountPrecision).toBe(0)
  })

  it('omits optional limit fields when absent', () => {
    const raw = makeBtcPerp({ limits: {} })
    const result = mapCcxtMarket('binance', raw)
    expect(result?.minPrice).toBeUndefined()
    expect(result?.maxPrice).toBeUndefined()
    expect(result?.minAmount).toBeUndefined()
    expect(result?.maxAmount).toBeUndefined()
    expect(result?.minCost).toBeUndefined()
  })

  it('defaults contractSize to 1 when absent', () => {
    const raw: CcxtMarket = {
      id: 'BTCUSDT',
      symbol: 'BTC/USDT:USDT',
      swap: true,
      linear: true,
      settle: 'USDT',
      active: true,
      maker: 0,
      taker: 0,
      info: {},
    }
    expect(mapCcxtMarket('binance', raw)?.contractSize).toBe(1)
  })

  it('maxLeverage is undefined for exchanges without info parsing', () => {
    const raw = makeBtcPerp({ info: {} })
    expect(mapCcxtMarket('bybit', raw)?.maxLeverage).toBeUndefined()
  })
})
