import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'

import { createEventBus } from '../core/bus.js'
import { createClock } from '../core/clock.js'
import { createExecutionLogger } from '../core/logger.js'
import { MetricsRegistry, registerStateMetrics } from '../observability/metrics.js'
import { createStateStore } from './store.js'
import type { Order, Position, Balance } from '../adapters/rest/types.js'
import type { ExchangeRestAdapter } from '../adapters/rest/types.js'
import type { DesyncEvent } from './types.js'

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    clientOrderId: 'cid-1',
    exchangeOrderId: 'eid-1',
    side: 'buy',
    type: 'limit',
    qty: 1,
    filledQty: 0,
    reduceOnly: false,
    status: 'new',
    submittedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    qty: 1,
    side: 'long',
    leverage: 1,
    updatedAt: 1000,
    ...overrides,
  }
}

function makeBalance(overrides: Partial<Balance> = {}): Balance {
  return {
    exchange: 'binance',
    asset: 'USDT',
    available: 1000,
    locked: 0,
    updatedAt: 1000,
    ...overrides,
  }
}

function makeMockRest(
  openOrders: Order[] = [],
  positions: Position[] = [],
  balances: Balance[] = [],
  getOrderResult?: Order
): ExchangeRestAdapter {
  return {
    exchange: 'binance',
    setLeverage: vi.fn(),
    createOrder: vi.fn(),
    cancelOrder: vi.fn(),
    amendOrder: vi.fn(),
    getOpenOrders: vi.fn().mockResolvedValue(openOrders),
    getOrder: vi.fn().mockResolvedValue(getOrderResult),
    getPositions: vi.fn().mockResolvedValue(positions),
    getBalance: vi.fn().mockResolvedValue(balances),
    getServerTime: vi.fn().mockResolvedValue(Date.now()),
  }
}

function makeStoreWithRest(restAdapter: ExchangeRestAdapter) {
  const bus = createEventBus()
  const registry = new MetricsRegistry()
  const metrics = registerStateMetrics(registry)
  const clock = createClock()
  const restAdapters = new Map([['binance' as const, restAdapter]])
  const store = createStateStore({
    bus,
    restAdapters,
    exchanges: ['binance'],
    clock,
    logger: createExecutionLogger(),
    metrics,
  })
  store.start()
  return { bus, store, registry, metrics }
}

describe('reconcile', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Test 12: unknown_order
  it('emits unknown_order desync and applies REST order when not in local state', async () => {
    const restOrder = makeOrder()
    const rest = makeMockRest([restOrder])
    const { store } = makeStoreWithRest(rest)

    const desyncs: DesyncEvent[] = []
    store.onDesync(e => desyncs.push(e))

    await store.reconcile('binance')

    expect(desyncs.some(d => d.kind === 'unknown_order')).toBe(true)
    expect(store.orders('binance')).toHaveLength(1)
  })

  // Test 13: missing_order
  it('emits missing_order and applies terminal state for local open not in REST', async () => {
    const restForGetOrder = makeMockRest([], [], [], makeOrder({ status: 'cancelled' }))
    const { bus, store } = makeStoreWithRest(restForGetOrder)

    const desyncs: DesyncEvent[] = []
    store.onDesync(e => desyncs.push(e))

    // Put a local order in open state
    bus.emit('ws.order', { exchange: 'binance', order: makeOrder({ status: 'new' }), seq: 1, receivedAt: 1 })

    await store.reconcile('binance')

    expect(desyncs.some(d => d.kind === 'missing_order')).toBe(true)
    const orders = store.orders('binance')
    expect(orders[0]!.status).toBe('cancelled')
  })

  // Test 14: order_status_mismatch
  it('emits order_status_mismatch when local partially_filled but REST says filled', async () => {
    const restOrder = makeOrder({ status: 'filled', filledQty: 1 })
    const rest = makeMockRest([restOrder])
    const { bus, store } = makeStoreWithRest(rest)

    const desyncs: DesyncEvent[] = []
    store.onDesync(e => desyncs.push(e))

    // Set local state to partially_filled
    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder({ status: 'partially_filled', filledQty: 0.5 }),
      seq: 1,
      receivedAt: 1,
    })

    await store.reconcile('binance')

    expect(desyncs.some(d => d.kind === 'order_status_mismatch')).toBe(true)
    expect(store.orders('binance')[0]!.status).toBe('filled')
  })

  // Test 15: position_qty_mismatch
  it('emits position_qty_mismatch and converges when local qty differs from REST', async () => {
    const restPos = makePosition({ qty: 3, side: 'long' })
    const rest = makeMockRest([], [restPos])
    const { bus, store } = makeStoreWithRest(rest)

    const desyncs: DesyncEvent[] = []
    store.onDesync(e => desyncs.push(e))

    bus.emit('ws.position', {
      exchange: 'binance',
      position: makePosition({ qty: 2 }),
      seq: 1,
      receivedAt: 1,
    })

    await store.reconcile('binance')

    expect(desyncs.some(d => d.kind === 'position_qty_mismatch')).toBe(true)
    expect(store.positions('binance')[0]!.qty).toBe(3)
  })

  // Test 16: balance_mismatch
  it('emits balance_mismatch and converges when local balance differs from REST', async () => {
    const restBal = makeBalance({ available: 950, locked: 100 })
    const rest = makeMockRest([], [], [restBal])
    const { bus, store } = makeStoreWithRest(rest)

    const desyncs: DesyncEvent[] = []
    store.onDesync(e => desyncs.push(e))

    bus.emit('ws.balance', {
      exchange: 'binance',
      balance: makeBalance({ available: 1000, locked: 50 }),
      seq: 1,
      receivedAt: 1,
    })

    await store.reconcile('binance')

    expect(desyncs.some(d => d.kind === 'balance_mismatch')).toBe(true)
    expect(store.balances('binance')[0]!.available).toBe(950)
  })

  // Test 17: sequence_gap → reconcile invoked once
  it('detects sequence_gap and triggers reconcile exactly once', async () => {
    const rest = makeMockRest()
    const { bus, store } = makeStoreWithRest(rest)

    const reconcileSpy = vi.spyOn(store, 'reconcile').mockResolvedValue(undefined)

    bus.emit('ws.order', { exchange: 'binance', order: makeOrder({ clientOrderId: 'cid-1' }), seq: 1, receivedAt: 1 })
    bus.emit('ws.order', { exchange: 'binance', order: makeOrder({ clientOrderId: 'cid-2' }), seq: 3, receivedAt: 1 })

    expect(reconcileSpy).toHaveBeenCalledTimes(1)
    expect(reconcileSpy).toHaveBeenCalledWith('binance')
  })

  // Test 18: reconcile-on-reconnect (verification gate: ≤5s)
  it('triggers reconcile after ws.connection connected following disconnect', async () => {
    const restOrder = makeOrder({ status: 'filled', filledQty: 1 })
    const rest = makeMockRest([restOrder])
    const { bus, store } = makeStoreWithRest(rest)

    const desyncs: DesyncEvent[] = []
    store.onDesync(e => desyncs.push(e))

    bus.emit('ws.connection', { exchange: 'binance', state: 'disconnected', at: 1 })
    bus.emit('ws.connection', { exchange: 'binance', state: 'connected', at: 2 })

    await vi.runAllTimersAsync()

    expect(vi.mocked(rest.getOpenOrders)).toHaveBeenCalled()
    expect(desyncs.some(d => d.kind === 'unknown_order')).toBe(true)
    expect(store.orders('binance')[0]!.status).toBe('filled')
  })

  // Test 19: concurrent reconcile coalesced
  it('coalesces concurrent reconcile calls — REST invoked exactly once', async () => {
    let resolveReconcile: () => void
    const blockingPromise = new Promise<void>(r => {
      resolveReconcile = r
    })
    const rest = makeMockRest()
    vi.mocked(rest.getOpenOrders).mockReturnValue(blockingPromise.then(() => []))
    const { store } = makeStoreWithRest(rest)

    void store.reconcile('binance')
    void store.reconcile('binance')

    resolveReconcile!()
    await vi.runAllTimersAsync()

    expect(vi.mocked(rest.getOpenOrders)).toHaveBeenCalledTimes(1)
  })

  // Test 20: REST failure leaves local untouched
  it('leaves local state untouched and increments error counter on REST failure', async () => {
    const rest = makeMockRest()
    vi.mocked(rest.getOpenOrders).mockRejectedValue(new Error('network error'))
    const { bus, store, registry } = makeStoreWithRest(rest)

    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder({ clientOrderId: 'cid-1' }),
      seq: 1,
      receivedAt: 1,
    })

    await store.reconcile('binance')

    expect(store.orders('binance')).toHaveLength(1)
    const body = await registry.render()
    expect(body).toMatch(/state_reconcile_total\{exchange="binance",status="error"\}/)
  })
})
