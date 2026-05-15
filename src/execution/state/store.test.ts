import { describe, expect, it, vi } from 'vitest'

import { createEventBus } from '../core/bus.js'
import { createClock } from '../core/clock.js'
import { createExecutionLogger } from '../core/logger.js'
import { MetricsRegistry, registerStateMetrics } from '../observability/metrics.js'
import type { Order, Position, Balance, ExchangeRestAdapter } from '../adapters/rest/types.js'
import { createStateStore } from './store.js'
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

function makeMockRest(overrides: Partial<ExchangeRestAdapter> = {}): ExchangeRestAdapter {
  return {
    exchange: 'binance',
    setLeverage: vi.fn(),
    createOrder: vi.fn(),
    cancelOrder: vi.fn(),
    amendOrder: vi.fn(),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOrder: vi.fn().mockResolvedValue(undefined),
    getPositions: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue([]),
    getServerTime: vi.fn().mockResolvedValue(Date.now()),
    ...overrides,
  }
}

function makeStore(restAdapter?: ExchangeRestAdapter) {
  const bus = createEventBus()
  const registry = new MetricsRegistry()
  const metrics = registerStateMetrics(registry)
  const restAdapters = restAdapter ? new Map([['binance' as const, restAdapter]]) : new Map()
  const store = createStateStore({
    bus,
    restAdapters,
    exchanges: ['binance'],
    clock: createClock(),
    logger: createExecutionLogger(),
    metrics,
  })
  store.start()
  return { bus, store, registry }
}

describe('StateStore', () => {
  // Test 8: ws.order events are applied and queries return correct slices
  it('applies ws.order events and returns correct orders', () => {
    const { bus, store } = makeStore()

    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder({ clientOrderId: 'cid-1', symbol: 'BTCUSDT' }),
      seq: 1,
      receivedAt: Date.now(),
    })
    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder({ clientOrderId: 'cid-2', symbol: 'ETHUSDT' }),
      seq: 2,
      receivedAt: Date.now(),
    })

    expect(store.orders('binance')).toHaveLength(2)
    expect(store.orders('binance', 'BTCUSDT')).toHaveLength(1)
    expect(store.orders('binance', 'BTCUSDT')[0]!.clientOrderId).toBe('cid-1')
    expect(store.orders('binance', 'ETHUSDT')[0]!.clientOrderId).toBe('cid-2')
  })

  // Test 8: filled order removed from open-index
  it('removes filled order from open-index but retains in ordersByCid', () => {
    const { bus, store } = makeStore()

    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder({ clientOrderId: 'cid-1', status: 'new' }),
      seq: 1,
      receivedAt: Date.now(),
    })

    // Update to filled
    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder({ clientOrderId: 'cid-1', status: 'filled', filledQty: 1 }),
      seq: 2,
      receivedAt: Date.now(),
    })

    // Order still in store
    expect(store.orders('binance')).toHaveLength(1)
    expect(store.orders('binance')[0]!.status).toBe('filled')
  })

  // Test 9: cancelled order removed from open-index but retained
  it('retains cancelled order in store but removes from open-index', () => {
    const { bus, store } = makeStore()

    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder({ clientOrderId: 'cid-1', status: 'new' }),
      seq: 1,
      receivedAt: Date.now(),
    })
    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder({ clientOrderId: 'cid-1', status: 'cancelled' }),
      seq: 2,
      receivedAt: Date.now(),
    })

    const all = store.orders('binance')
    expect(all).toHaveLength(1)
    expect(all[0]!.status).toBe('cancelled')
  })

  // Test 10: position upsert + flat
  it('upserts positions and filters zero-qty on read', () => {
    const { bus, store } = makeStore()

    bus.emit('ws.position', {
      exchange: 'binance',
      position: makePosition({ symbol: 'BTCUSDT', qty: 1, side: 'long' }),
      seq: 1,
      receivedAt: Date.now(),
    })
    bus.emit('ws.position', {
      exchange: 'binance',
      position: makePosition({ symbol: 'ETHUSDT', qty: 0, side: 'flat' }),
      seq: 2,
      receivedAt: Date.now(),
    })

    const positions = store.positions('binance')
    expect(positions).toHaveLength(1)
    expect(positions[0]!.symbol).toBe('BTCUSDT')
  })

  // Test 11: balance upsert by asset
  it('upserts balances by asset (latest wins)', () => {
    const { bus, store } = makeStore()

    bus.emit('ws.balance', {
      exchange: 'binance',
      balance: makeBalance({ asset: 'USDT', available: 1000, updatedAt: 1000 }),
      seq: 1,
      receivedAt: Date.now(),
    })
    bus.emit('ws.balance', {
      exchange: 'binance',
      balance: makeBalance({ asset: 'USDT', available: 950, updatedAt: 2000 }),
      seq: 2,
      receivedAt: Date.now(),
    })

    const bals = store.balances('binance', 'USDT')
    expect(bals).toHaveLength(1)
    expect(bals[0]!.available).toBe(950)
  })

  it('returns empty arrays for unknown exchanges', () => {
    const { store } = makeStore()
    expect(store.orders('okx')).toHaveLength(0)
    expect(store.positions('okx')).toHaveLength(0)
    expect(store.balances('okx')).toHaveLength(0)
  })

  it('stop() unsubscribes from bus events', () => {
    const { bus, store } = makeStore()
    store.stop()

    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder(),
      seq: 1,
      receivedAt: Date.now(),
    })

    expect(store.orders('binance')).toHaveLength(0)
  })

  it('initializes ordersSize gauge to 0 on start', async () => {
    const { registry } = makeStore()
    const body = await registry.render()
    expect(body).toMatch(/state_orders_size\{exchange="binance"\} 0/)
  })

  // Desync listener
  it('calls onDesync listeners for sequence_gap events', () => {
    const { bus, store } = makeStore()
    const desyncs: DesyncEvent[] = []
    store.onDesync(e => desyncs.push(e))

    bus.emit('ws.order', { exchange: 'binance', order: makeOrder(), seq: 1, receivedAt: Date.now() })
    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder({ clientOrderId: 'cid-2' }),
      seq: 3,
      receivedAt: Date.now(),
    })

    expect(desyncs.some(d => d.kind === 'sequence_gap')).toBe(true)
  })

  it('triggers reconcile on ws.connection connected after disconnected', async () => {
    const { bus, store } = makeStore()
    const reconcileSpy = vi.spyOn(store, 'reconcile').mockResolvedValue(undefined)

    bus.emit('ws.connection', { exchange: 'binance', state: 'disconnected', at: 1 })
    bus.emit('ws.connection', { exchange: 'binance', state: 'connected', at: 2 })

    expect(reconcileSpy).toHaveBeenCalledWith('binance')
  })

  it('triggers reconcile on first-ever connected', async () => {
    const { bus, store } = makeStore()
    const reconcileSpy = vi.spyOn(store, 'reconcile').mockResolvedValue(undefined)

    bus.emit('ws.connection', { exchange: 'binance', state: 'connected', at: 1 })

    expect(reconcileSpy).toHaveBeenCalledWith('binance')
  })

  // TELEM-01: reconcile success logs store.reconcile.complete at INFO
  it('TELEM-01: resolves reconcile and does not emit reconcile_failed opsEvent on success', async () => {
    const rest = makeMockRest()
    const { bus, store } = makeStore(rest)

    const opsEvents: unknown[] = []
    bus.on('ops.event', e => opsEvents.push(e))

    await store.reconcile('binance')

    expect(opsEvents).toHaveLength(0)
  })

  // TELEM-01: reconcile failure emits reconcile_failed opsEvent at critical level.
  // runReconcile catches REST errors internally (returns gracefully); only unhandled
  // post-fetch exceptions propagate. Simulate by returning null (bypasses try/catch,
  // then crashes on restOrders.map() outside it).
  it('TELEM-01: emits reconcile_failed opsEvent at critical level when reconcile throws', async () => {
    const rest = makeMockRest({
      getOpenOrders: vi.fn().mockResolvedValue(null as unknown as Order[]),
    })
    const { bus, store } = makeStore(rest)

    const opsEvents: { eventType: string; level: string }[] = []
    bus.on('ops.event', e => opsEvents.push(e as { eventType: string; level: string }))

    await expect(store.reconcile('binance')).rejects.toThrow()

    expect(opsEvents).toHaveLength(1)
    expect(opsEvents[0]!.eventType).toBe('reconcile_failed')
    expect(opsEvents[0]!.level).toBe('fatal')
  })
})
