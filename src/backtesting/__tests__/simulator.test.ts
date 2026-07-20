import { describe, it, expect } from 'vitest'
import type { OrderbookRow } from '../../db/types.js'
import { simulateOrders, simulateLadderOrders } from '../orders/simulator.js'
import type { Order } from '../orders/types.js'

function makeCandle(ts: string, overrides: Partial<OrderbookRow> = {}): OrderbookRow {
  return {
    exchange: 'binanceusdm',
    symbol: 'BTCUSDT',
    ts,
    bid_open: 50000,
    bid_high: 50050,
    bid_low: 49950,
    bid_close: 50000,
    ask_open: 50010,
    ask_high: 50060,
    ask_low: 49960,
    ask_close: 50010,
    source_type: 'raw',
    is_interpolated: false,
    confidence_score: '1.0',
    missing_reason: null,
    ...overrides,
  }
}

describe('Order Simulator', () => {
  it('SL/TP same-candle ambiguity resolves to SL (worst-case) for long', () => {
    const candles: OrderbookRow[] = [
      makeCandle('2025-06-01 00:00:01', {
        // SL condition for long: bid_low <= stop_price (SELL STOP)
        bid_low: 49800,
        // TP condition for long: bid_high > limit_price (SELL LIMIT)
        bid_high: 50200,
      }),
    ]

    const orders: Order[] = [
      {
        side: 'sell',
        type: 'stop',
        price: 49900,
        quantity: 1,
        validFrom: '2025-06-01 00:00:01',
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: true,
        label: 'sl',
      },
      {
        side: 'sell',
        type: 'limit',
        price: 50100,
        quantity: 1,
        validFrom: '2025-06-01 00:00:01',
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: true,
        label: 'tp',
      },
    ]

    const result = simulateOrders(orders, candles, 0.0001, 'long')
    expect(result.fills).toHaveLength(1)
    expect(result.fills[0]?.label).toBe('sl')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.message).toContain('SL and TP both triggered')
  })

  it('SL/TP same-candle ambiguity resolves to SL (worst-case) for short', () => {
    const candles: OrderbookRow[] = [
      makeCandle('2025-06-01 00:00:01', {
        // SL condition for short: ask_high >= stop_price (BUY STOP)
        ask_high: 51000,
        // TP condition for short: ask_low < limit_price (BUY LIMIT)
        ask_low: 49500,
      }),
    ]

    const orders: Order[] = [
      {
        side: 'buy',
        type: 'stop',
        price: 50500,
        quantity: 1,
        validFrom: '2025-06-01 00:00:01',
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: true,
        label: 'sl',
      },
      {
        side: 'buy',
        type: 'limit',
        price: 49600,
        quantity: 1,
        validFrom: '2025-06-01 00:00:01',
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: true,
        label: 'tp',
      },
    ]

    const result = simulateOrders(orders, candles, 0.0001, 'short')
    expect(result.fills).toHaveLength(1)
    expect(result.fills[0]?.label).toBe('sl')
    expect(result.warnings).toHaveLength(1)
  })

  it('TP fills on a later candle when SL is not triggered', () => {
    const candles: OrderbookRow[] = [
      makeCandle('2025-06-01 00:00:01', { bid_high: 50020, bid_low: 49980 }),
      makeCandle('2025-06-01 00:00:02', { bid_high: 50150, bid_low: 50050 }),
    ]

    const orders: Order[] = [
      {
        side: 'sell',
        type: 'stop',
        price: 49900,
        quantity: 1,
        validFrom: '2025-06-01 00:00:01',
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: true,
        label: 'sl',
      },
      {
        side: 'sell',
        type: 'limit',
        price: 50100,
        quantity: 1,
        validFrom: '2025-06-01 00:00:01',
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: true,
        label: 'tp',
      },
    ]

    const result = simulateOrders(orders, candles, 0.0001, 'long')
    expect(result.fills).toHaveLength(1)
    expect(result.fills[0]?.label).toBe('tp')
    expect(result.fills[0]?.timestamp).toBe('2025-06-01 00:00:02')
    expect(result.warnings).toHaveLength(0)
  })

  it('validUntil is inclusive: order fires on the exact validUntil candle', () => {
    const candles: OrderbookRow[] = [
      makeCandle('2025-06-01 00:00:01', { bid_high: 50050, bid_low: 49950 }),
      makeCandle('2025-06-01 00:00:02', { bid_high: 50050, bid_low: 49950 }),
      makeCandle('2025-06-01 00:00:03', { bid_high: 50050, bid_low: 49950 }),
      makeCandle('2025-06-01 00:00:04', { bid_high: 50200, bid_low: 49950 }), // TP fires here
    ]

    const orders: Order[] = [
      {
        side: 'sell',
        type: 'limit',
        price: 50100,
        quantity: 1,
        validFrom: '2025-06-01 00:00:01',
        validUntil: '2025-06-01 00:00:04', // exactly the last candle
        reduceOnly: true,
        label: 'tp',
      },
    ]

    const result = simulateOrders(orders, candles, 0, 'long')
    expect(result.fills).toHaveLength(1)
    expect(result.fills[0]?.label).toBe('tp')
    expect(result.fills[0]?.timestamp).toBe('2025-06-01 00:00:04')
  })

  it('orders outside validFrom/validUntil are not processed', () => {
    const candles: OrderbookRow[] = [makeCandle('2025-06-01 00:00:01', { bid_high: 50200 })]

    const orders: Order[] = [
      {
        side: 'sell',
        type: 'limit',
        price: 50100,
        quantity: 1,
        validFrom: '2025-06-01 00:00:05', // After candle
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: true,
        label: 'tp',
      },
    ]

    const result = simulateOrders(orders, candles, 0, 'long')
    expect(result.fills).toHaveLength(0)
  })

  it('caps a reduce-only fill quantity at the remaining positionSize', () => {
    const candles: OrderbookRow[] = [makeCandle('2025-06-01 00:00:01', { bid_high: 50200 })]

    const orders: Order[] = [
      {
        side: 'sell',
        type: 'limit',
        price: 50100,
        quantity: 2,
        validFrom: '2025-06-01 00:00:01',
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: true,
        label: 'tp',
      },
    ]

    const result = simulateOrders(orders, candles, 0, 'long', 0.5)
    expect(result.fills).toHaveLength(1)
    expect(result.fills[0]?.quantity).toBe(0.5)
  })

  it('drops a reduce-only fill with a warning once positionSize is already exhausted', () => {
    const candles: OrderbookRow[] = [
      makeCandle('2025-06-01 00:00:01', { bid_high: 50200 }),
      makeCandle('2025-06-01 00:00:02', { bid_high: 50200 }),
    ]

    const orders: Order[] = [
      {
        side: 'sell',
        type: 'limit',
        price: 50100,
        quantity: 1,
        validFrom: '2025-06-01 00:00:01',
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: true,
        label: 'tp1',
      },
      {
        side: 'sell',
        type: 'limit',
        price: 50100,
        quantity: 1,
        validFrom: '2025-06-01 00:00:01',
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: true,
        label: 'tp2',
      },
    ]

    const result = simulateOrders(orders, candles, 0, 'long', 1)
    expect(result.fills).toHaveLength(1)
    expect(result.fills[0]?.label).toBe('tp1')
    expect(result.warnings.some(w => w.message.includes('tp2'))).toBe(true)
  })

  it('is unaffected when positionSize is omitted (existing behavior)', () => {
    const candles: OrderbookRow[] = [makeCandle('2025-06-01 00:00:01', { bid_high: 50200 })]

    const orders: Order[] = [
      {
        side: 'sell',
        type: 'limit',
        price: 50100,
        quantity: 5,
        validFrom: '2025-06-01 00:00:01',
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: true,
        label: 'tp',
      },
    ]

    const result = simulateOrders(orders, candles, 0, 'long')
    expect(result.fills).toHaveLength(1)
    expect(result.fills[0]?.quantity).toBe(5)
  })

  it('SL fires on the entry candle when validFrom = entry ts, while TP stays gated to entry+1', () => {
    const candles: OrderbookRow[] = [
      makeCandle('2025-06-01 00:00:00', {
        // SL condition for long: bid_low <= stop_price (SELL STOP)
        bid_low: 49800,
        // Would also satisfy TP if it were valid on this candle (SELL LIMIT)
        bid_high: 50200,
      }),
    ]

    const orders: Order[] = [
      {
        side: 'sell',
        type: 'stop',
        price: 49900,
        quantity: 1,
        validFrom: '2025-06-01 00:00:00', // entry candle
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: true,
        label: 'sl',
      },
      {
        side: 'sell',
        type: 'limit',
        price: 50100,
        quantity: 1,
        validFrom: '2025-06-01 00:00:01', // entry + 1
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: true,
        label: 'tp',
      },
    ]

    const result = simulateOrders(orders, candles, 0, 'long')
    expect(result.fills).toHaveLength(1)
    expect(result.fills[0]?.label).toBe('sl')
    expect(result.fills[0]?.timestamp).toBe('2025-06-01 00:00:00')
  })

  it('credit-gated action never fires on the drop candle when validFrom is set to drop_candle + 1', () => {
    const candles: OrderbookRow[] = [
      makeCandle('2025-06-01 00:00:04', { bid_high: 50200 }), // drop candle itself — would satisfy TP
      makeCandle('2025-06-01 00:00:05', { bid_high: 50200 }), // drop_candle + 1 — first valid candle
    ]

    const orders: Order[] = [
      {
        side: 'sell',
        type: 'limit',
        price: 50100,
        quantity: 1,
        validFrom: '2025-06-01 00:00:05', // drop_candle (00:00:04) + 1s structural floor
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: true,
        label: 'tp',
      },
    ]

    const result = simulateOrders(orders, candles, 0, 'long')
    expect(result.fills).toHaveLength(1)
    expect(result.fills[0]?.timestamp).toBe('2025-06-01 00:00:05')
  })

  it('non-SL exit never fires on the entry candle even when priced favorably', () => {
    const candles: OrderbookRow[] = [
      makeCandle('2025-06-01 00:00:00', { bid_high: 50200, bid_low: 49950 }), // entry candle
    ]

    const orders: Order[] = [
      {
        side: 'sell',
        type: 'limit',
        price: 50100,
        quantity: 1,
        validFrom: '2025-06-01 00:00:01', // gated past entry candle
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: true,
        label: 'tp',
      },
    ]

    const result = simulateOrders(orders, candles, 0, 'long')
    expect(result.fills).toHaveLength(0)
  })
})

describe('Ladder Order Simulator', () => {
  it('fills some ladder orders based on price action', () => {
    const candles: OrderbookRow[] = [
      makeCandle('2025-06-01 00:00:01', { ask_low: 49500 }),
      makeCandle('2025-06-01 00:00:02', { ask_low: 49300 }),
    ]

    const orders: Order[] = [
      {
        side: 'buy',
        type: 'limit',
        price: 49600,
        quantity: 0.2,
        validFrom: '2025-06-01 00:00:00',
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: false,
        label: 'ladder_0',
      },
      {
        side: 'buy',
        type: 'limit',
        price: 49400,
        quantity: 0.2,
        validFrom: '2025-06-01 00:00:00',
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: false,
        label: 'ladder_1',
      },
      {
        side: 'buy',
        type: 'limit',
        price: 49200,
        quantity: 0.2,
        validFrom: '2025-06-01 00:00:00',
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: false,
        label: 'ladder_2',
      },
    ]

    const { fills, unfilled } = simulateLadderOrders(orders, candles)
    expect(fills).toHaveLength(2) // 49600 and 49400 fill
    expect(unfilled).toBe(1) // 49200 does not fill
  })

  it('no fills when price stays above all ladder levels', () => {
    const candles: OrderbookRow[] = [makeCandle('2025-06-01 00:00:01', { ask_low: 49800 })]

    const orders: Order[] = [
      {
        side: 'buy',
        type: 'limit',
        price: 49600,
        quantity: 0.5,
        validFrom: '2025-06-01 00:00:00',
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: false,
        label: 'ladder_0',
      },
      {
        side: 'buy',
        type: 'limit',
        price: 49400,
        quantity: 0.5,
        validFrom: '2025-06-01 00:00:00',
        validUntil: '2025-06-01 00:01:00',
        reduceOnly: false,
        label: 'ladder_1',
      },
    ]

    const { fills, unfilled } = simulateLadderOrders(orders, candles)
    expect(fills).toHaveLength(0)
    expect(unfilled).toBe(2)
  })
})
