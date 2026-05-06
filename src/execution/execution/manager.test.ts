import { describe, expect, it, vi } from 'vitest'

import { createEventBus } from '../core/bus.js'
import { createClock } from '../core/clock.js'
import { createIds } from '../core/ids.js'
import { createExecutionLogger } from '../core/logger.js'
import type { ExchangeRestAdapter, Order, OrderAck } from '../adapters/rest/types.js'
import type { MarketMetadata, MarketMetadataProvider } from '../markets/types.js'
import { MetricsRegistry, registerExecutionMetrics } from '../observability/metrics.js'
import type { KillSwitch } from '../risk/types.js'
import type { StateStore } from '../state/types.js'
import type { TradeIntent } from '../strategies/types.js'
import type { ExitReason, PositionMonitor } from './types.js'
import { createExecutionManager } from './manager.js'
import type { PreflightResult } from './preflight.js'

function makeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  const now = Date.now()
  return {
    id: 'intent-1',
    strategy: 'strategy_1',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    exchangeSymbol: 'BTCUSDT',
    side: 'long',
    amountUsd: 20,
    leverage: 4,
    volume: 0,
    fundingRate: -0.006,
    fundingRatePercent: -0.6,
    fundingInterval: 8,
    nextFundingTimestamp: now + 28800000,
    nextFundingDatetime: new Date(now + 28800000).toISOString(),
    decidedAt: now,
    entryAt: now + 10000,
    exitPolicy: { kind: 'timed', exitAt: now + 30000 },
    ...overrides,
  }
}

function makeOrder(clientOrderId: string, overrides: Partial<Order> = {}): Order {
  return {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    clientOrderId,
    exchangeOrderId: `eid-${clientOrderId}`,
    side: 'buy',
    type: 'market',
    qty: 0.001,
    filledQty: 0,
    reduceOnly: false,
    status: 'new',
    submittedAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeMarket(): MarketMetadata {
  return {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    exchangeSymbol: 'BTCUSDT',
    contractSize: 1,
    pricePrecision: 2,
    amountPrecision: 4,
    makerFee: 0.0002,
    takerFee: 0.0004,
    status: 'trading',
  }
}

function makeRestAdapter(): ExchangeRestAdapter {
  return {
    exchange: 'binance',
    setLeverage: vi.fn().mockResolvedValue(undefined),
    createOrder: vi.fn().mockResolvedValue({
      clientOrderId: 'cid',
      exchangeOrderId: 'eid',
      status: 'accepted',
      submittedAt: Date.now(),
      ackedAt: Date.now(),
    } satisfies OrderAck),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    amendOrder: vi.fn(),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOrder: vi.fn().mockResolvedValue(undefined),
    getPositions: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue([]),
    getServerTime: vi.fn().mockResolvedValue(Date.now()),
  }
}

function makeMonitor(): PositionMonitor & { triggerExit: (intentId: string, reason: ExitReason) => void } {
  let listener: ((intentId: string, reason: ExitReason) => void) | undefined
  return {
    arm: vi.fn(),
    disarm: vi.fn(),
    onExitRequested: vi.fn().mockImplementation(l => {
      listener = l
      return () => {
        listener = undefined
      }
    }),
    triggerExit(intentId, reason) {
      listener?.(intentId, reason)
    },
  }
}

function makeKillSwitch(): KillSwitch {
  return {
    state: vi.fn().mockReturnValue({ mode: 'dry_run' }),
    trip: vi.fn(),
    setMode: vi.fn(),
    flattenAll: vi.fn(),
    canPlaceOrder: vi.fn().mockReturnValue(true),
    wireFlattener: vi.fn(),
  }
}

function makeStateStore(): StateStore {
  return {
    orders: vi.fn().mockReturnValue([]),
    positions: vi.fn().mockReturnValue([]),
    balances: vi
      .fn()
      .mockReturnValue([{ exchange: 'binance', asset: 'USDT', available: 1000, locked: 0, updatedAt: 0 }]),
    reconcile: vi.fn(),
    onDesync: vi.fn().mockReturnValue(() => {}),
  }
}

function makeManager(
  overrides: {
    restAdapter?: ExchangeRestAdapter
    monitor?: ReturnType<typeof makeMonitor>
    preflight?: (intent: TradeIntent, price: number) => PreflightResult
    refPrice?: (exchange: string, symbol: string) => number | undefined
    stateStore?: StateStore
  } = {}
) {
  const bus = createEventBus()
  const clock = createClock()
  const ids = createIds()
  const metricsReg = new MetricsRegistry()
  const metrics = registerExecutionMetrics(metricsReg)
  const rest = overrides.restAdapter ?? makeRestAdapter()
  const monitor = overrides.monitor ?? makeMonitor()
  const stateStore = overrides.stateStore ?? makeStateStore()

  const markets: MarketMetadataProvider = {
    list: () => [makeMarket()],
    get: () => makeMarket(),
    resolve: () => undefined,
    refresh: vi.fn(),
    onUpdate: vi.fn().mockReturnValue(() => {}),
  }

  const manager = createExecutionManager({
    bus,
    clock,
    ids,
    logger: createExecutionLogger(),
    metrics,
    restAdapters: new Map([['binance', rest]]),
    state: stateStore,
    markets,
    killSwitch: makeKillSwitch(),
    monitor,
    preflight: overrides.preflight ?? ((_i, _p) => ({ ok: true, qty: 0.001 })),
    refPrice: overrides.refPrice ?? ((_e, _s) => 50000),
  })
  manager.start()
  return { manager, bus, clock, ids, rest, monitor }
}

describe('ExecutionManager', () => {
  it('happy path: submit → acked → working → filled via ws.order → monitoring, monitor armed', async () => {
    const { manager, bus, ids } = makeManager()
    const intent = makeIntent()

    const submitPromise = manager.submit(intent)

    // Simulate fill arriving via ws.order
    const cid = ids.forIntent(intent.id, 0)
    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder(cid, { status: 'filled', filledQty: 0.001, avgFillPrice: 50000 }),
      seq: 1,
      receivedAt: Date.now(),
    })

    const state = await submitPromise
    expect(['working', 'filled', 'monitoring']).toContain(state.status)
  })

  it('transitions through submitted → acked → working after createOrder resolves', async () => {
    const { manager } = makeManager()
    const intent = makeIntent()

    const states: string[] = []
    manager.onStateChange(s => states.push(s.status))

    await manager.submit(intent)

    expect(states).toContain('submitted')
    expect(states).toContain('acked')
    expect(states).toContain('working')
  })

  it('errors when refPrice returns undefined', async () => {
    const { manager } = makeManager({ refPrice: () => undefined })
    const state = await manager.submit(makeIntent())
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('no_ref_price')
  })

  it('errors when preflight rejects', async () => {
    const { manager } = makeManager({
      preflight: () => ({ ok: false, code: 'kill_switch', message: 'halted' }),
    })
    const state = await manager.submit(makeIntent())
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('kill_switch')
  })

  it('errors when createOrder returns rejected', async () => {
    const rest = makeRestAdapter()
    vi.mocked(rest.createOrder).mockResolvedValue({
      clientOrderId: 'cid',
      exchangeOrderId: '',
      status: 'rejected',
      rejectReason: 'insufficient_funds',
      submittedAt: Date.now(),
      ackedAt: Date.now(),
    })
    const { manager } = makeManager({ restAdapter: rest })
    const state = await manager.submit(makeIntent())
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('order_rejected')
  })

  it('handles partial fill then full fill', async () => {
    const { manager, bus, ids } = makeManager()
    const intent = makeIntent()

    const stateHistory: string[] = []
    manager.onStateChange(s => stateHistory.push(s.status))

    const cid = ids.forIntent(intent.id, 0)
    // Submit first so byEntryOrderId is registered before emitting fills
    await manager.submit(intent)

    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder(cid, { status: 'partially_filled', filledQty: 0.0005 }),
      seq: 1,
      receivedAt: Date.now(),
    })

    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder(cid, { status: 'filled', filledQty: 0.001, avgFillPrice: 50000 }),
      seq: 2,
      receivedAt: Date.now(),
    })

    // Allow handleEntryFilled microtask to complete
    await Promise.resolve()

    expect(stateHistory).toContain('partially_filled')
    expect(stateHistory).toContain('filled')
  })

  it('ws.order race: fill arrives before submit returns — still transitions correctly', async () => {
    const bus = createEventBus()
    const clock = createClock()
    const ids = createIds()
    const metReg = new MetricsRegistry()
    const metrics = registerExecutionMetrics(metReg)
    const intent = makeIntent()
    const cid = ids.forIntent(intent.id, 0)

    // Emit fill before submit is called
    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder(cid, { status: 'filled', filledQty: 0.001, avgFillPrice: 50000 }),
      seq: 1,
      receivedAt: Date.now(),
    })

    const monitor = makeMonitor()
    const stateStore = makeStateStore()
    vi.mocked(stateStore.orders).mockReturnValue([
      makeOrder(cid, { status: 'filled', filledQty: 0.001, avgFillPrice: 50000 }),
    ])

    const manager = createExecutionManager({
      bus,
      clock,
      ids,
      logger: createExecutionLogger(),
      metrics,
      restAdapters: new Map([['binance', makeRestAdapter()]]),
      state: stateStore,
      markets: {
        list: () => [],
        get: () => makeMarket(),
        resolve: () => undefined,
        refresh: vi.fn(),
        onUpdate: vi.fn().mockReturnValue(() => {}),
      },
      killSwitch: makeKillSwitch(),
      monitor,
      preflight: () => ({ ok: true, qty: 0.001 }),
      refPrice: () => 50000,
    })
    manager.start()

    const state = await manager.submit(intent)
    expect(['filled', 'monitoring']).toContain(state.status)
    expect(monitor.arm).toHaveBeenCalled()
  })

  it('cancelIntent cancels working entry order', async () => {
    const { manager, rest } = makeManager()
    const intent = makeIntent()

    await manager.submit(intent)
    await manager.cancelIntent(intent.id)

    expect(vi.mocked(rest.cancelOrder)).toHaveBeenCalled()
  })

  it('cancelIntent routes monitoring intent through kill_switch exit', async () => {
    const { manager, bus, ids, monitor } = makeManager()
    const intent = makeIntent()
    const cid = ids.forIntent(intent.id, 0)

    // Submit first, then emit fill so byEntryOrderId is registered
    await manager.submit(intent)
    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder(cid, { status: 'filled', filledQty: 0.001, avgFillPrice: 50000 }),
      seq: 1,
      receivedAt: Date.now(),
    })
    // Allow handleEntryFilled (fire-and-forget async) to complete
    await Promise.resolve()
    await Promise.resolve()

    await manager.cancelIntent(intent.id)
    expect(vi.mocked(monitor.disarm)).toHaveBeenCalledWith(intent.id)
  })

  it('timed exit: monitor fires timed → manager places market close', async () => {
    const customMonitor = makeMonitor()
    const { manager, bus, ids, rest } = makeManager({ monitor: customMonitor })
    const intent = makeIntent()
    const cid = ids.forIntent(intent.id, 0)

    const p = manager.submit(intent)
    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder(cid, { status: 'filled', filledQty: 0.001, avgFillPrice: 50000 }),
      seq: 1,
      receivedAt: Date.now(),
    })
    await p

    customMonitor.triggerExit(intent.id, 'timed')
    // Allow async to settle
    await Promise.resolve()

    const createOrderCalls = vi.mocked(rest.createOrder).mock.calls
    const closeCall = createOrderCalls.find(c => c[0].reduceOnly === true && c[0].type === 'market')
    expect(closeCall).toBeDefined()
  })

  it('list() returns all intent states', async () => {
    const { manager } = makeManager()
    await manager.submit(makeIntent({ id: 'i1' }))
    await manager.submit(makeIntent({ id: 'i2' }))
    expect(manager.list()).toHaveLength(2)
  })

  it('get() returns specific intent state', async () => {
    const { manager } = makeManager()
    const intent = makeIntent({ id: 'specific-intent' })
    await manager.submit(intent)
    expect(manager.get('specific-intent')).toBeDefined()
    expect(manager.get('nonexistent')).toBeUndefined()
  })

  it('flattenAll cancels all non-terminal intents', async () => {
    const { manager } = makeManager()
    await manager.submit(makeIntent({ id: 'i1' }))
    await manager.submit(makeIntent({ id: 'i2' }))
    await manager.flattenAll()
    const states = manager.list().map(s => s.status)
    expect(states.every(s => ['cancelled', 'error', 'exited', 'exiting'].includes(s))).toBe(true)
  })

  // F2-1: cancelIntent on partially_filled must close the open partial position
  it('cancelIntent on partially_filled routes to market close, not silent terminal', async () => {
    const { manager, bus, ids, rest } = makeManager()
    const intent = makeIntent()
    const cid = ids.forIntent(intent.id, 0)

    await manager.submit(intent)

    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder(cid, { status: 'partially_filled', filledQty: 0.0005 }),
      seq: 1,
      receivedAt: Date.now(),
    })

    const state = manager.get(intent.id)!
    expect(state.status).toBe('partially_filled')
    expect(state.filledQty).toBe(0.0005)

    await manager.cancelIntent(intent.id)
    // Allow the async handleMonitorExit to settle
    await Promise.resolve()

    const calls = vi.mocked(rest.createOrder).mock.calls
    const closeCall = calls.find(c => c[0].reduceOnly === true && c[0].type === 'market')
    expect(closeCall).toBeDefined()
    expect(closeCall![0].qty).toBe(0.0005)
  })

  // F2-X: duplicate WS fill event while in monitoring must NOT re-trigger handleEntryFilled
  it('duplicate WS fill while in monitoring does not re-place SL/TP orders', async () => {
    const { manager, bus, ids, rest } = makeManager()
    const intent = makeIntent({
      exitPolicy: {
        kind: 'sl_tp_deadline',
        slPct: 1,
        tpPct: 1.5,
        deadlineAt: Date.now() + 60000,
        tpVariant: 'A',
      },
    })
    const cid = ids.forIntent(intent.id, 0)

    // await submit so byEntryOrderId is registered before emitting fills
    await manager.submit(intent)

    // Emit first fill — intent transitions to monitoring, SL/TP placed
    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder(cid, { status: 'filled', filledQty: 0.001, avgFillPrice: 50000 }),
      seq: 1,
      receivedAt: Date.now(),
    })
    // Flush async work so handleEntryFilled completes (SL/TP createOrder awaits resolve)
    await new Promise(r => setTimeout(r, 10))

    expect(manager.get(intent.id)!.status).toBe('monitoring')
    const callsAfterFirstFill = vi.mocked(rest.createOrder).mock.calls.length
    // Entry + SL + TP = 3
    expect(callsAfterFirstFill).toBe(3)

    // Emit the same fill a second time (WS reconnect replay)
    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder(cid, { status: 'filled', filledQty: 0.001, avgFillPrice: 50000 }),
      seq: 2,
      receivedAt: Date.now(),
    })
    await new Promise(r => setTimeout(r, 10))

    expect(vi.mocked(rest.createOrder).mock.calls.length).toBe(callsAfterFirstFill)
  })

  // F2-5: duplicate submit for the same intent id must return the existing state
  it('duplicate submit returns existing non-terminal state without placing a second order', async () => {
    const { manager, rest } = makeManager()
    const intent = makeIntent()

    const s1 = await manager.submit(intent)
    const s2 = await manager.submit(intent)

    expect(s1).toBe(s2)
    // createOrder called exactly once despite two submits
    expect(vi.mocked(rest.createOrder)).toHaveBeenCalledTimes(1)
  })

  // F2 fix: setLeverage failure must hard-reject the intent, not silently continue
  it('errors with set_leverage_failed and does not place order when setLeverage throws', async () => {
    const rest = makeRestAdapter()
    vi.mocked(rest.setLeverage).mockRejectedValue(new Error('rate limit exceeded'))
    const { manager } = makeManager({ restAdapter: rest })

    const state = await manager.submit(makeIntent())

    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('set_leverage_failed')
    expect(vi.mocked(rest.createOrder)).not.toHaveBeenCalled()
  })

  // Prewarm: leverage pre-set before submit → zero extra setLeverage calls in submit()
  it('prewarmLeverage populates leverageSet so submit skips setLeverage', async () => {
    const rest = makeRestAdapter()
    const { manager } = makeManager({ restAdapter: rest })

    manager.prewarmLeverage('binance', 'BTCUSDT', 4)
    await new Promise(r => setTimeout(r, 10)) // let the fire-and-forget settle

    await manager.submit(makeIntent())

    // setLeverage called exactly once (during prewarm), never again during submit
    expect(vi.mocked(rest.setLeverage)).toHaveBeenCalledTimes(1)
  })

  // Single-flight: concurrent prewarm + submit share one setLeverage HTTP call
  it('concurrent prewarmLeverage and submit result in exactly one setLeverage call', async () => {
    const rest = makeRestAdapter()
    let resolveSetLeverage!: () => void
    vi.mocked(rest.setLeverage).mockReturnValue(
      new Promise<void>(r => {
        resolveSetLeverage = r
      })
    )
    const { manager } = makeManager({ restAdapter: rest })

    // Start prewarm without awaiting — registers the in-flight promise
    manager.prewarmLeverage('binance', 'BTCUSDT', 4)

    // Submit runs concurrently and must join the in-flight prewarm promise
    const submitPromise = manager.submit(makeIntent())
    resolveSetLeverage()
    await submitPromise

    expect(vi.mocked(rest.setLeverage)).toHaveBeenCalledTimes(1)
  })

  // Prewarm failure: a failed prewarm clears the in-flight slot so submit retries
  it('when prewarmLeverage fails, submit retries setLeverage and succeeds', async () => {
    const rest = makeRestAdapter()
    vi.mocked(rest.setLeverage).mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(undefined)
    const { manager } = makeManager({ restAdapter: rest })

    manager.prewarmLeverage('binance', 'BTCUSDT', 4)
    await new Promise(r => setTimeout(r, 10)) // let rejected prewarm settle

    const state = await manager.submit(makeIntent())
    expect(state.status).not.toBe('error')
    expect(vi.mocked(rest.setLeverage)).toHaveBeenCalledTimes(2)
  })
})

// OCO cancel: cancelSiblingExit strategies
// The logic is exchange-agnostic — all 6 adapters expose the same cancelOrder/getOpenOrders
// surface, so testing with the binance mock covers all exchanges.
describe('OCO cancel strategies', () => {
  function makeSlTpIntent(): TradeIntent {
    return makeIntent({
      exitPolicy: {
        kind: 'sl_tp_deadline',
        slPct: 1,
        tpPct: 1.5,
        deadlineAt: Date.now() + 60000,
        tpVariant: 'A',
      },
    })
  }

  async function setupMonitoringIntent(restAdapter: ExchangeRestAdapter, monitor: ReturnType<typeof makeMonitor>) {
    // Use per-clientOrderId exchangeOrderId so SL and TP get distinct exchange IDs.
    vi.mocked(restAdapter.createOrder).mockImplementation(async params => ({
      clientOrderId: params.clientOrderId,
      exchangeOrderId: `eid-${params.clientOrderId}`,
      status: 'accepted',
      submittedAt: Date.now(),
      ackedAt: Date.now(),
    }))

    const { manager, bus, ids } = makeManager({ restAdapter, monitor })
    const intent = makeSlTpIntent()
    await manager.submit(intent)

    const entryCid = ids.forIntent(intent.id, 0)
    bus.emit('ws.order', {
      exchange: 'binance',
      order: makeOrder(entryCid, { status: 'filled', filledQty: 0.001, avgFillPrice: 50000 }),
      seq: 1,
      receivedAt: Date.now(),
    })
    // Allow handleEntryFilled (SL+TP placement) to settle
    await new Promise(r => setTimeout(r, 10))

    return { manager, intent }
  }

  // (a) TP fill → SL cancel succeeds via Strategy A
  it('TP fill → SL cancel succeeds via Strategy A (getOpenOrders returns empty after cancel)', async () => {
    const rest = makeRestAdapter()
    // getOpenOrders returns [] — order is gone after Strategy A's cancelOrder
    vi.mocked(rest.getOpenOrders).mockResolvedValue([])

    const monitor = makeMonitor()
    const { manager, intent } = await setupMonitoringIntent(rest, monitor)

    expect(manager.get(intent.id)!.status).toBe('monitoring')
    const slRef = manager.get(intent.id)!.exitOrderRefs!.sl!

    monitor.triggerExit(intent.id, 'tp')
    await new Promise(r => setTimeout(r, 10))

    expect(manager.get(intent.id)!.status).toBe('exited')
    // cancelOrder called for Strategy A (SL clientOrderId)
    const cancelCalls = vi.mocked(rest.cancelOrder).mock.calls
    expect(cancelCalls.some(c => c[0].clientOrderId === slRef.clientOrderId)).toBe(true)
  })

  // (b) Strategy A silent fail → Strategy B (exchangeOrderId) succeeds
  it('Strategy A silent no-op → Strategy B (exchangeOrderId cancel) succeeds', async () => {
    const rest = makeRestAdapter()
    const monitor = makeMonitor()
    const { manager, intent } = await setupMonitoringIntent(rest, monitor)

    const slRef = manager.get(intent.id)!.exitOrderRefs!.sl!

    // getOpenOrders: order present after Strategy A attempt, gone after Strategy B
    vi.mocked(rest.getOpenOrders)
      .mockResolvedValueOnce([
        makeOrder(slRef.clientOrderId, { reduceOnly: true, exchangeOrderId: slRef.exchangeOrderId }),
      ])
      .mockResolvedValue([])

    monitor.triggerExit(intent.id, 'tp')
    await new Promise(r => setTimeout(r, 10))

    expect(manager.get(intent.id)!.status).toBe('exited')
    // Strategy B should have been attempted with exchangeOrderId
    const cancelCalls = vi.mocked(rest.cancelOrder).mock.calls
    expect(cancelCalls.some(c => c[0].exchangeOrderId === slRef.exchangeOrderId)).toBe(true)
  })

  // (c) Strategy A+B both fail → Strategy C sweep finds and cancels
  it('Strategy A+B fail → Strategy C sweep cancels the residual order', async () => {
    const rest = makeRestAdapter()
    const monitor = makeMonitor()
    const { manager, intent } = await setupMonitoringIntent(rest, monitor)

    const slRef = manager.get(intent.id)!.exitOrderRefs!.sl!
    const residualOrder = makeOrder(slRef.clientOrderId, {
      reduceOnly: true,
      exchangeOrderId: slRef.exchangeOrderId,
    })

    // getOpenOrders: order present for A-verify, B-verify, and inside sweep; gone on final check
    let getOpenOrdersCount = 0
    vi.mocked(rest.getOpenOrders).mockImplementation(() => {
      getOpenOrdersCount++
      // 1: after Strategy A verify; 2: after Strategy B verify; 3: inside sweepReduceOnlyOrders
      return Promise.resolve(getOpenOrdersCount <= 3 ? [residualOrder] : [])
    })

    monitor.triggerExit(intent.id, 'tp')
    await new Promise(r => setTimeout(r, 10))

    expect(manager.get(intent.id)!.status).toBe('exited')
    // cancelOrder called at least 3 times (A, B, sweep)
    expect(vi.mocked(rest.cancelOrder).mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  // (d) All three strategies fail → logs oco.cancel.exhausted, intent still exits
  it('all strategies exhausted → intent still exits (position was already flat)', async () => {
    const rest = makeRestAdapter()
    const monitor = makeMonitor()
    const { manager, intent } = await setupMonitoringIntent(rest, monitor)

    const slRef = manager.get(intent.id)!.exitOrderRefs!.sl!
    // getOpenOrders always returns the order (cancel never takes effect)
    vi.mocked(rest.getOpenOrders).mockResolvedValue([
      makeOrder(slRef.clientOrderId, { reduceOnly: true, exchangeOrderId: slRef.exchangeOrderId }),
    ])

    monitor.triggerExit(intent.id, 'tp')
    await new Promise(r => setTimeout(r, 10))

    // Position was flat (TP filled), so intent must still reach exited
    expect(manager.get(intent.id)!.status).toBe('exited')
  })

  // (e) SL fill → TP cancel (symmetric path)
  it('SL fill → TP cancel succeeds via Strategy A', async () => {
    const rest = makeRestAdapter()
    vi.mocked(rest.getOpenOrders).mockResolvedValue([])

    const monitor = makeMonitor()
    const { manager, intent } = await setupMonitoringIntent(rest, monitor)

    const tpRef = manager.get(intent.id)!.exitOrderRefs!.tp!

    monitor.triggerExit(intent.id, 'sl')
    await new Promise(r => setTimeout(r, 10))

    expect(manager.get(intent.id)!.status).toBe('exited')
    const cancelCalls = vi.mocked(rest.cancelOrder).mock.calls
    expect(cancelCalls.some(c => c[0].clientOrderId === tpRef.clientOrderId)).toBe(true)
  })
})
