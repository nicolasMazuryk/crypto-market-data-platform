import { describe, expect, it } from 'vitest'

import { normalizeSymbol } from './symbol-normalizer.js'

describe('normalizeSymbol', () => {
  it('removes separators and uppercases', () => {
    expect(normalizeSymbol('btc/usdt:usdt')).toBe('BTCUSDT')
  })

  it('strips underscores, dashes, and trailing swap suffixes', () => {
    expect(normalizeSymbol('1000RATS_USDT')).toBe('1000RATSUSDT')
    expect(normalizeSymbol('BTC-USDT-SWAP')).toBe('BTCUSDT')
  })
})
