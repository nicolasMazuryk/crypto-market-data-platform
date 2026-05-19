import { describe, expect, it, vi } from 'vitest'

import { mapAccountUpdate, mapFundingFee, mapOrderTradeUpdate } from './mapping.js'
import type { BinanceAccountUpdateRaw, BinanceOrderUpdateRaw } from './mapping.js'
import { FundingRateCache } from './funding-rate-cache.js'

const ORDER_UPDATE: BinanceOrderUpdateRaw = {
  e: 'ORDER_TRADE_UPDATE',
  E: 1700000000000,
  T: 1700000000000,
  o: {
    s: 'BTCUSDT',
    c: 'test-cid-1',
    S: 'BUY',
    o: 'LIMIT',
    q: '0.001',
    p: '30000',
    ap: '0',
    sp: '0',
    X: 'NEW',
    i: 12345678,
    z: '0',
    R: false,
    T: '1700000000000',
  },
}

const FILLED_ORDER_UPDATE: BinanceOrderUpdateRaw = {
  ...ORDER_UPDATE,
  o: { ...ORDER_UPDATE.o, X: 'FILLED', z: '0.001', ap: '29999' },
}

const ACCOUNT_UPDATE: BinanceAccountUpdateRaw = {
  e: 'ACCOUNT_UPDATE',
  E: 1700000001000,
  T: 1700000001000,
  a: {
    m: 'ORDER',
    B: [{ a: 'USDT', wb: '10000', cw: '9500', bc: '0' }],
    P: [{ s: 'BTCUSDT', pa: '0.001', ep: '30000', up: '5.0', ps: 'BOTH' }],
  },
}

const FUNDING_FEE_UPDATE: BinanceAccountUpdateRaw = {
  e: 'ACCOUNT_UPDATE',
  E: 1700000002000,
  T: 1700000002000,
  a: {
    m: 'FUNDING_FEE',
    B: [{ a: 'USDT', wb: '9995.5', cw: '9495.5', bc: '-4.5' }],
    P: [{ s: 'ETHUSDT', pa: '10', ep: '2000', up: '0', ps: 'BOTH' }],
  },
}

describe('mapOrderTradeUpdate', () => {
  it('maps NEW order correctly', () => {
    const event = mapOrderTradeUpdate(ORDER_UPDATE, 1700000000100, 1)
    expect(event.exchange).toBe('binance')
    expect(event.seq).toBe(1)
    expect(event.order.symbol).toBe('BTCUSDT')
    expect(event.order.clientOrderId).toBe('test-cid-1')
    expect(event.order.exchangeOrderId).toBe('12345678')
    expect(event.order.side).toBe('buy')
    expect(event.order.type).toBe('limit')
    expect(event.order.qty).toBe(0.001)
    expect(event.order.filledQty).toBe(0)
    expect(event.order.status).toBe('new')
    expect(event.order.price).toBe(30000)
    expect(event.order.reduceOnly).toBe(false)
  })

  it('maps FILLED order status', () => {
    const event = mapOrderTradeUpdate(FILLED_ORDER_UPDATE, 1700000000100, 2)
    expect(event.order.status).toBe('filled')
    expect(event.order.filledQty).toBe(0.001)
    expect(event.order.avgFillPrice).toBe(29999)
  })

  it('maps SELL side', () => {
    const raw = { ...ORDER_UPDATE, o: { ...ORDER_UPDATE.o, S: 'SELL' } }
    const event = mapOrderTradeUpdate(raw, 0, 1)
    expect(event.order.side).toBe('sell')
  })

  it('falls back to o.C when o.c is empty (cancel/replace and some FILLED events)', () => {
    const raw = { ...FILLED_ORDER_UPDATE, o: { ...FILLED_ORDER_UPDATE.o, c: '', C: 'close-xyz-original' } }
    const event = mapOrderTradeUpdate(raw, 0, 1)
    expect(event.order.clientOrderId).toBe('close-xyz-original')
  })

  it('uses o.c when non-empty, ignores o.C', () => {
    const raw = { ...ORDER_UPDATE, o: { ...ORDER_UPDATE.o, c: 'primary-cid', C: 'original-cid' } }
    const event = mapOrderTradeUpdate(raw, 0, 1)
    expect(event.order.clientOrderId).toBe('primary-cid')
  })
})

describe('mapAccountUpdate', () => {
  it('maps balances from ACCOUNT_UPDATE', () => {
    const { balances } = mapAccountUpdate(ACCOUNT_UPDATE, 1700000001100, 3)
    expect(balances).toHaveLength(1)
    expect(balances[0]!.balance.asset).toBe('USDT')
    expect(balances[0]!.balance.available).toBe(9500)
    expect(balances[0]!.balance.locked).toBe(500)
    expect(balances[0]!.seq).toBe(3)
  })

  it('maps positions from ACCOUNT_UPDATE', () => {
    const { balances: _, positions } = mapAccountUpdate(ACCOUNT_UPDATE, 1700000001100, 3)
    expect(positions).toHaveLength(1)
    expect(positions[0]!.position.symbol).toBe('BTCUSDT')
    expect(positions[0]!.position.qty).toBe(0.001)
    expect(positions[0]!.position.side).toBe('long')
    expect(positions[0]!.position.entryPrice).toBe(30000)
    expect(positions[0]!.position.unrealizedPnl).toBe(5.0)
  })

  it('maps short position (negative pa)', () => {
    const raw: BinanceAccountUpdateRaw = {
      ...ACCOUNT_UPDATE,
      a: { ...ACCOUNT_UPDATE.a, P: [{ ...ACCOUNT_UPDATE.a.P[0]!, pa: '-0.5' }] },
    }
    const { positions } = mapAccountUpdate(raw, 0, 1)
    expect(positions[0]!.position.side).toBe('short')
    expect(positions[0]!.position.qty).toBe(0.5)
  })
})

describe('mapFundingFee', () => {
  it('maps FUNDING_FEE event', () => {
    const event = mapFundingFee(FUNDING_FEE_UPDATE, 1700000002100, 5)
    expect(event).not.toBeNull()
    expect(event!.exchange).toBe('binance')
    expect(event!.symbol).toBe('ETHUSDT')
    expect(event!.fundingAmount).toBe(-4.5)
    expect(event!.asset).toBe('USDT')
    expect(event!.positionQty).toBe(10)
    expect(event!.fundingTime).toBe(1700000002000)
  })

  it('returns null for non-FUNDING_FEE events', () => {
    expect(mapFundingFee(ACCOUNT_UPDATE, 0, 1)).toBeNull()
  })

  it('returns event with symbol="" when a.P is empty and B has balance data', () => {
    const emptyPEvent: BinanceAccountUpdateRaw = {
      e: 'ACCOUNT_UPDATE',
      E: 1700000002000,
      T: 1700000002000,
      a: {
        m: 'FUNDING_FEE',
        B: [{ a: 'USDT', wb: '9995.5', cw: '9495.5', bc: '-4.5' }],
        P: [],
      },
    }
    const cache = new FundingRateCache()
    cache.set('ETHUSDT', 0.0001, 1700000002000)
    cache.set('BTCUSDT', 0.0002, 1700000002000)

    const event = mapFundingFee(emptyPEvent, 1700000002100, 5, 'binance', cache)
    expect(event).not.toBeNull()
    expect(event?.symbol).toBe('')
    expect(event?.fundingAmount).toBe(-4.5)
    expect(event?.asset).toBe('USDT')
    expect(event?.fundingRate).toBe(0)
    expect(event?.positionQty).toBe(0)
  })

  it('returns event with symbol="" when a.P empty and no rate cache', () => {
    const emptyPEvent: BinanceAccountUpdateRaw = {
      e: 'ACCOUNT_UPDATE',
      E: 1700000002000,
      T: 1700000002000,
      a: {
        m: 'FUNDING_FEE',
        B: [{ a: 'USDT', wb: '9995.5', cw: '9495.5', bc: '-4.5' }],
        P: [],
      },
    }
    const event = mapFundingFee(emptyPEvent, 1700000002100, 5, 'binance', undefined)
    expect(event).not.toBeNull()
    expect(event?.symbol).toBe('')
    expect(event?.fundingAmount).toBe(-4.5)
  })
})
