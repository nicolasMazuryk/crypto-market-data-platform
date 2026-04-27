import { describe, it, expect } from 'vitest'
import type { IntentLifecycle } from '../../persistence/queries.js'
import type { TradeIntentRow, OrderRow, FillRow } from '../../persistence/queries.js'

function makeIntentRow(overrides?: Partial<TradeIntentRow>): TradeIntentRow {
  return {
    id: 'intent-1',
    runId: 'run-1',
    strategy: 'strategy_1',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    exchangeSymbol: 'BTCUSDT',
    side: 'short',
    amountUsd: '20',
    leverage: 4,
    fundingRate: '-0.0005',
    fundingRatePercent: '-0.05',
    fundingInterval: 8,
    nextFundingTs: new Date(),
    decidedAt: new Date(),
    entryAt: null,
    status: 'exited',
    decisionReason: null,
    exitPolicy: { kind: 'timed', exitAt: Date.now() + 3600_000 },
    fundingSnapshot: {
      exchange: 'binance',
      symbol: 'BTCUSDT',
      fundingRate: -0.0005,
      fundingRatePercent: -0.05,
      fundingInterval: 8,
    },
    ...overrides,
  }
}

function makeOrderRow(overrides?: Partial<OrderRow>): OrderRow {
  return {
    id: 'order-1',
    intentId: 'intent-1',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    clientOrderId: 'coid-1',
    exchangeOrderId: 'exoid-1',
    side: 'sell',
    type: 'market',
    reduceOnly: false,
    qty: '0.0005',
    filledQty: '0.0005',
    price: null,
    status: 'filled',
    submittedAt: new Date(),
    ackedAt: new Date(),
    terminalAt: new Date(),
    rawSnapshot: null,
    ...overrides,
  }
}

function makeFillRow(overrides?: Partial<FillRow>): FillRow {
  return {
    id: 'fill-1',
    orderId: 'order-1',
    exchange: 'binance',
    exchangeFillId: 'fill-id-1',
    qty: '0.0005',
    price: '40000',
    feeAsset: 'USDT',
    feeAmount: '0.02',
    isMaker: false,
    ts: new Date(),
    ...overrides,
  }
}

function makeLifecycle(overrides?: Partial<IntentLifecycle>): IntentLifecycle {
  return {
    intent: makeIntentRow(),
    orders: [makeOrderRow()],
    fills: [makeFillRow()],
    fundingAttributions: [],
    opsEvents: [],
    ...overrides,
  }
}

describe('replay lifecycle PnL computation', () => {
  it('computes zero PnL when no fills', () => {
    const lc = makeLifecycle({ fills: [] })
    const { intent, orders, fills, fundingAttributions } = lc

    const entryOrderIds = new Set(orders.filter(o => !o.reduceOnly).map(o => o.id))
    const exitOrderIds = new Set(orders.filter(o => o.reduceOnly).map(o => o.id))

    const entryFills = fills.filter(f => entryOrderIds.has(f.orderId))
    const exitFills = fills.filter(f => exitOrderIds.has(f.orderId))

    const entryValue = entryFills.reduce((s, f) => s + parseFloat(f.qty) * parseFloat(f.price), 0)
    const exitValue = exitFills.reduce((s, f) => s + parseFloat(f.qty) * parseFloat(f.price), 0)
    const totalFees = fills.reduce((s, f) => s + parseFloat(f.feeAmount), 0)
    const fundingTotal = fundingAttributions.reduce((s, f) => s + parseFloat(f.fundingAmount), 0)

    const pnl = intent.side === 'long' ? exitValue - entryValue - totalFees + fundingTotal : entryValue - exitValue - totalFees + fundingTotal

    expect(pnl).toBe(0)
    expect(entryFills.length).toBe(0)
    expect(exitFills.length).toBe(0)
  })

  it('includes funding attribution in PnL', () => {
    const lc = makeLifecycle({
      fills: [],
      fundingAttributions: [
        {
          id: 'fa-1',
          exchange: 'binance',
          symbol: 'BTCUSDT',
          positionId: null,
          fundingTime: new Date(),
          fundingRate: '-0.0005',
          fundingAmount: '0.50',
          asset: 'USDT',
          ts: new Date(),
        },
      ],
    })

    const fundingTotal = lc.fundingAttributions.reduce((s, f) => s + parseFloat(f.fundingAmount), 0)
    expect(fundingTotal).toBe(0.5)
  })

  it('computes PnL for short position: entry - exit - fees + funding', () => {
    // Short: sell 0.001 BTC at 40000, buy back at 39000, fee 0.04
    const entryOrder = makeOrderRow({ id: 'entry-order', reduceOnly: false })
    const exitOrder = makeOrderRow({ id: 'exit-order', reduceOnly: true, side: 'buy' })
    const entryFill = makeFillRow({ orderId: 'entry-order', qty: '0.001', price: '40000', feeAmount: '0.02' })
    const exitFill = makeFillRow({ id: 'fill-2', orderId: 'exit-order', qty: '0.001', price: '39000', feeAmount: '0.02' })

    const lc = makeLifecycle({
      orders: [entryOrder, exitOrder],
      fills: [entryFill, exitFill],
      intent: makeIntentRow({ side: 'short' }),
    })

    const { orders, fills, fundingAttributions } = lc
    const entryOrderIds = new Set(orders.filter(o => !o.reduceOnly).map(o => o.id))
    const exitOrderIds = new Set(orders.filter(o => o.reduceOnly).map(o => o.id))

    const entryFills = fills.filter(f => entryOrderIds.has(f.orderId))
    const exitFills = fills.filter(f => exitOrderIds.has(f.orderId))

    const entryValue = entryFills.reduce((s, f) => s + parseFloat(f.qty) * parseFloat(f.price), 0)
    const exitValue = exitFills.reduce((s, f) => s + parseFloat(f.qty) * parseFloat(f.price), 0)
    const totalFees = fills.reduce((s, f) => s + parseFloat(f.feeAmount), 0)
    const fundingTotal = fundingAttributions.reduce((s, f) => s + parseFloat(f.fundingAmount), 0)

    // short PnL = entry - exit - fees + funding
    const pnl = entryValue - exitValue - totalFees + fundingTotal
    // 40 - 39 - 0.04 = 0.96
    expect(pnl).toBeCloseTo(0.96, 4)
  })

  it('detects reevaluate parity when funding snapshot matches', () => {
    const intent = makeIntentRow({
      fundingRate: '-0.0005',
      fundingSnapshot: { fundingRate: -0.0005 },
    })
    makeLifecycle({ intent })

    const snapshot = intent.fundingSnapshot as Record<string, unknown> | null
    expect(snapshot).not.toBeNull()
    if (!snapshot) return

    const diffs: { field: string; persisted: unknown; reevaluated: unknown }[] = []
    if (String(snapshot.fundingRate) !== intent.fundingRate) {
      diffs.push({ field: 'fundingRate', persisted: intent.fundingRate, reevaluated: snapshot.fundingRate })
    }

    expect(diffs.length).toBe(0)
  })

  it('detects reevaluate divergence when funding rate changed', () => {
    const intent = makeIntentRow({
      fundingRate: '-0.0005',
      fundingSnapshot: { fundingRate: -0.001 }, // changed
    })

    const snapshot = intent.fundingSnapshot as Record<string, unknown> | null
    expect(snapshot).not.toBeNull()
    if (!snapshot) return

    const diffs: { field: string; persisted: unknown; reevaluated: unknown }[] = []
    if (String(snapshot.fundingRate) !== intent.fundingRate) {
      diffs.push({ field: 'fundingRate', persisted: intent.fundingRate, reevaluated: snapshot.fundingRate })
    }

    expect(diffs.length).toBe(1)
    expect(diffs[0]?.field).toBe('fundingRate')
  })
})
