import { describe, expect, it } from 'vitest'

import { createIds } from './ids.js'

describe('ExecutionIds.intentId', () => {
  const ids = createIds()

  it('returns a 32-char hex string', () => {
    const id = ids.intentId('strategy_1', 'binance', 'BTCUSDT', 1_700_000_000_000)
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is deterministic for same inputs', () => {
    const a = ids.intentId('strategy_1', 'binance', 'BTCUSDT', 1_700_000_000_000)
    const b = ids.intentId('strategy_1', 'binance', 'BTCUSDT', 1_700_000_000_000)
    expect(a).toBe(b)
  })

  it('differs across strategies', () => {
    const a = ids.intentId('strategy_1', 'binance', 'BTCUSDT', 1_700_000_000_000)
    const b = ids.intentId('strategy_3a', 'binance', 'BTCUSDT', 1_700_000_000_000)
    expect(a).not.toBe(b)
  })

  it('differs across exchanges', () => {
    const a = ids.intentId('strategy_1', 'binance', 'BTCUSDT', 1_700_000_000_000)
    const b = ids.intentId('strategy_1', 'bitget', 'BTCUSDT', 1_700_000_000_000)
    expect(a).not.toBe(b)
  })

  it('differs across symbols', () => {
    const a = ids.intentId('strategy_1', 'binance', 'BTCUSDT', 1_700_000_000_000)
    const b = ids.intentId('strategy_1', 'binance', 'ETHUSDT', 1_700_000_000_000)
    expect(a).not.toBe(b)
  })

  it('differs across funding timestamps', () => {
    const a = ids.intentId('strategy_1', 'binance', 'BTCUSDT', 1_700_000_000_000)
    const b = ids.intentId('strategy_1', 'binance', 'BTCUSDT', 1_700_000_008_000)
    expect(a).not.toBe(b)
  })
})
