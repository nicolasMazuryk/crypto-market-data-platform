import { describe, expect, it } from 'vitest'

import { createEventBus } from '../core/bus.js'
import { createClock } from '../core/clock.js'
import { createExecutionLogger } from '../core/logger.js'
import { MetricsRegistry, registerExecutionMetrics } from '../observability/metrics.js'
import type { ExitReason, IntentState } from './types.js'
import { createPositionMonitor } from './monitor.js'

function makeMetrics() {
  const registry = new MetricsRegistry()
  return registerExecutionMetrics(registry)
}

function makeFundingFeeState(intentId: string, now: number, exchange = 'binance', symbol = 'BTCUSDT'): IntentState {
  return {
    intent: {
      id: intentId,
      strategy: 'strategy_1_ws',
      exchange: exchange as 'binance',
      symbol,
      exchangeSymbol: symbol,
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
      exitPolicy: {
        kind: 'funding_fee_event',
        fundingTs: now + 100,
        timeoutAt: now + 120_000,
      },
    },
    status: 'monitoring',
    filledQty: 0.001,
    updatedAt: now,
  }
}

function makeState(
  intentId: string,
  kind: 'timed' | 'sl_tp_deadline',
  now: number,
  slTpIds?: [string, string]
): IntentState {
  const exitPolicy =
    kind === 'timed'
      ? { kind: 'timed' as const, exitAt: now + 1000 }
      : {
          kind: 'sl_tp_deadline' as const,
          slPct: 1,
          tpPct: 1,
          deadlineAt: now + 5000,
          tpVariant: 'A' as const,
        }

  return {
    intent: {
      id: intentId,
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
      exitPolicy,
    },
    status: 'monitoring',
    filledQty: 0.001,
    updatedAt: now,
    ...(slTpIds !== undefined
      ? { exitOrderRefs: { sl: { clientOrderId: slTpIds[0] }, tp: { clientOrderId: slTpIds[1] } } }
      : {}),
  }
}

describe('PositionMonitor', () => {
  it('timed: fires exit reason after delay', () => {
    const bus = createEventBus()
    const clock = createClock()
    const timers: { cb: () => void; ms: number }[] = []
    const monitor = createPositionMonitor({
      bus,
      clock,
      logger: createExecutionLogger(),
      metrics: makeMetrics(),
      setTimeoutFn: (cb, ms) => {
        timers.push({ cb, ms })
        return timers.length - 1
      },
      clearTimeoutFn: () => {},
    })

    const exits: { intentId: string; reason: ExitReason }[] = []
    monitor.onExitRequested((intentId, reason) => exits.push({ intentId, reason }))

    const now = Date.now()
    monitor.arm(makeState('i1', 'timed', now))

    expect(timers).toHaveLength(1)
    timers[0]!.cb()

    expect(exits).toHaveLength(1)
    expect(exits[0]).toEqual({ intentId: 'i1', reason: 'timed' })
  })

  it('timed: fires only once even if timer callback runs twice', () => {
    const bus = createEventBus()
    const clock = createClock()
    const timers: { cb: () => void }[] = []
    const monitor = createPositionMonitor({
      bus,
      clock,
      logger: createExecutionLogger(),
      metrics: makeMetrics(),
      setTimeoutFn: cb => {
        timers.push({ cb })
        return timers.length - 1
      },
      clearTimeoutFn: () => {},
    })

    const exits: ExitReason[] = []
    monitor.onExitRequested((_id, reason) => exits.push(reason))

    monitor.arm(makeState('i1', 'timed', Date.now()))
    timers[0]!.cb()
    timers[0]!.cb()

    expect(exits).toHaveLength(1)
  })

  it('sl_tp_deadline: tp wins when tp order fills first', () => {
    const bus = createEventBus()
    const clock = createClock()
    const timers: { cb: () => void }[] = []
    const monitor = createPositionMonitor({
      bus,
      clock,
      logger: createExecutionLogger(),
      metrics: makeMetrics(),
      setTimeoutFn: cb => {
        timers.push({ cb })
        return timers.length - 1
      },
      clearTimeoutFn: () => {},
    })

    const exits: { intentId: string; reason: ExitReason }[] = []
    monitor.onExitRequested((intentId, reason) => exits.push({ intentId, reason }))

    const now = Date.now()
    const slId = 'sl-order-id'
    const tpId = 'tp-order-id'
    monitor.arm(makeState('i1', 'sl_tp_deadline', now, [slId, tpId]))

    bus.emit('ws.order', {
      exchange: 'binance',
      order: {
        exchange: 'binance',
        symbol: 'BTCUSDT',
        clientOrderId: tpId,
        exchangeOrderId: 'eid-tp',
        side: 'sell',
        type: 'limit',
        qty: 0.001,
        filledQty: 0.001,
        reduceOnly: true,
        status: 'filled',
        submittedAt: now,
        updatedAt: now,
      },
      seq: 1,
      receivedAt: now,
    })

    expect(exits).toHaveLength(1)
    expect(exits[0]).toEqual({ intentId: 'i1', reason: 'tp' })
  })

  it('sl_tp_deadline: sl wins when sl order fills first', () => {
    const bus = createEventBus()
    const clock = createClock()
    const timers: { cb: () => void }[] = []
    const monitor = createPositionMonitor({
      bus,
      clock,
      logger: createExecutionLogger(),
      metrics: makeMetrics(),
      setTimeoutFn: cb => {
        timers.push({ cb })
        return timers.length - 1
      },
      clearTimeoutFn: () => {},
    })

    const exits: { intentId: string; reason: ExitReason }[] = []
    monitor.onExitRequested((intentId, reason) => exits.push({ intentId, reason }))

    const now = Date.now()
    const slId = 'sl-order-id'
    const tpId = 'tp-order-id'
    monitor.arm(makeState('i1', 'sl_tp_deadline', now, [slId, tpId]))

    bus.emit('ws.order', {
      exchange: 'binance',
      order: {
        exchange: 'binance',
        symbol: 'BTCUSDT',
        clientOrderId: slId,
        exchangeOrderId: 'eid-sl',
        side: 'sell',
        type: 'stop_market',
        qty: 0.001,
        filledQty: 0.001,
        reduceOnly: true,
        status: 'filled',
        submittedAt: now,
        updatedAt: now,
      },
      seq: 2,
      receivedAt: now,
    })

    expect(exits).toHaveLength(1)
    expect(exits[0]).toEqual({ intentId: 'i1', reason: 'sl' })
  })

  it('sl_tp_deadline: deadline fires when timer triggers', () => {
    const bus = createEventBus()
    const clock = createClock()
    const timers: { cb: () => void }[] = []
    const monitor = createPositionMonitor({
      bus,
      clock,
      logger: createExecutionLogger(),
      metrics: makeMetrics(),
      setTimeoutFn: cb => {
        timers.push({ cb })
        return timers.length - 1
      },
      clearTimeoutFn: () => {},
    })

    const exits: ExitReason[] = []
    monitor.onExitRequested((_id, reason) => exits.push(reason))

    const now = Date.now()
    monitor.arm(makeState('i1', 'sl_tp_deadline', now, ['sl-id', 'tp-id']))

    // Timer index 0 is the deadline timer
    timers[0]!.cb()

    expect(exits).toHaveLength(1)
    expect(exits[0]).toBe('deadline')
  })

  it('sl_tp_deadline: only fires once if both sl fills and deadline fires', () => {
    const bus = createEventBus()
    const clock = createClock()
    const timers: { cb: () => void }[] = []
    const monitor = createPositionMonitor({
      bus,
      clock,
      logger: createExecutionLogger(),
      metrics: makeMetrics(),
      setTimeoutFn: cb => {
        timers.push({ cb })
        return timers.length - 1
      },
      clearTimeoutFn: () => {},
    })

    const exits: ExitReason[] = []
    monitor.onExitRequested((_id, reason) => exits.push(reason))

    const now = Date.now()
    const slId = 'sl-order-id'
    monitor.arm(makeState('i1', 'sl_tp_deadline', now, [slId, 'tp-id']))

    bus.emit('ws.order', {
      exchange: 'binance',
      order: {
        exchange: 'binance',
        symbol: 'BTCUSDT',
        clientOrderId: slId,
        exchangeOrderId: 'eid',
        side: 'sell',
        type: 'stop_market',
        qty: 0.001,
        filledQty: 0.001,
        reduceOnly: true,
        status: 'filled',
        submittedAt: now,
        updatedAt: now,
      },
      seq: 3,
      receivedAt: now,
    })

    // Deadline fires after sl already settled
    timers[0]!.cb()

    expect(exits).toHaveLength(1)
    expect(exits[0]).toBe('sl')
  })

  it('disarm clears all timers and unsubscribes', () => {
    const bus = createEventBus()
    const clock = createClock()
    const cleared: unknown[] = []
    const timers: { cb: () => void }[] = []
    const monitor = createPositionMonitor({
      bus,
      clock,
      logger: createExecutionLogger(),
      metrics: makeMetrics(),
      setTimeoutFn: cb => {
        timers.push({ cb })
        return timers.length - 1
      },
      clearTimeoutFn: h => cleared.push(h),
    })

    const exits: ExitReason[] = []
    monitor.onExitRequested((_id, reason) => exits.push(reason))

    const now = Date.now()
    monitor.arm(makeState('i1', 'timed', now))
    monitor.disarm('i1')

    timers[0]!.cb()

    expect(exits).toHaveLength(0)
    expect(cleared).toHaveLength(1)
  })

  it('stop disarms all armed intents', () => {
    const bus = createEventBus()
    const clock = createClock()
    const cleared: unknown[] = []
    const timers: { cb: () => void }[] = []
    const monitor = createPositionMonitor({
      bus,
      clock,
      logger: createExecutionLogger(),
      metrics: makeMetrics(),
      setTimeoutFn: cb => {
        timers.push({ cb })
        return timers.length - 1
      },
      clearTimeoutFn: h => cleared.push(h),
    })

    const now = Date.now()
    monitor.arm(makeState('i1', 'timed', now))
    monitor.arm(makeState('i2', 'timed', now))
    monitor.stop()

    expect(cleared).toHaveLength(2)
  })

  it('re-arming same intentId replaces the old entry', () => {
    const bus = createEventBus()
    const clock = createClock()
    const cleared: unknown[] = []
    const timers: { cb: () => void }[] = []
    const monitor = createPositionMonitor({
      bus,
      clock,
      logger: createExecutionLogger(),
      metrics: makeMetrics(),
      setTimeoutFn: cb => {
        timers.push({ cb })
        return timers.length - 1
      },
      clearTimeoutFn: h => cleared.push(h),
    })

    const exits: ExitReason[] = []
    monitor.onExitRequested((_id, reason) => exits.push(reason))

    const now = Date.now()
    monitor.arm(makeState('i1', 'timed', now))
    monitor.arm(makeState('i1', 'timed', now)) // re-arm: clears old timer

    expect(cleared).toHaveLength(1) // old timer cleared
    timers[1]!.cb() // new timer fires
    expect(exits).toHaveLength(1)
  })

  describe('funding_fee_event exit policy', () => {
    function makeMonitor() {
      const bus = createEventBus()
      const clock = createClock()
      const timers: { cb: () => void }[] = []
      const monitor = createPositionMonitor({
        bus,
        clock,
        logger: createExecutionLogger(),
        metrics: makeMetrics(),
        setTimeoutFn: cb => {
          timers.push({ cb })
          return timers.length - 1
        },
        clearTimeoutFn: () => {},
      })
      const exits: { intentId: string; reason: ExitReason }[] = []
      monitor.onExitRequested((intentId, reason) => exits.push({ intentId, reason }))
      return { bus, monitor, timers, exits }
    }

    function makeFundingEvent(now: number, exchange = 'binance', symbol = 'BTCUSDT', fundingTime?: number) {
      return {
        exchange: exchange as 'binance',
        symbol,
        fundingTime: fundingTime ?? now + 100,
        fundingRate: -0.006,
        fundingAmount: -0.05,
        asset: 'USDT',
        positionQty: 0.001,
        receivedAt: now + 110,
      }
    }

    it('exits with funding_fee when WS event arrives with matching exchange, symbol, and fundingTime', () => {
      const { bus, monitor, exits } = makeMonitor()
      const now = Date.now()
      monitor.arm(makeFundingFeeState('i1', now))

      bus.emit('ws.funding_fee', makeFundingEvent(now))

      expect(exits).toHaveLength(1)
      expect(exits[0]).toEqual({ intentId: 'i1', reason: 'funding_fee' })
    })

    it('falls back to funding_fee_timeout when timer fires', () => {
      const { monitor, timers, exits } = makeMonitor()
      const now = Date.now()
      monitor.arm(makeFundingFeeState('i1', now))

      // Timer at index 0 is the timeout handle
      timers[0]!.cb()

      expect(exits).toHaveLength(1)
      expect(exits[0]).toEqual({ intentId: 'i1', reason: 'funding_fee_timeout' })
    })

    it('ignores ws.funding_fee events from wrong exchange', () => {
      const { bus, monitor, timers, exits } = makeMonitor()
      const now = Date.now()
      monitor.arm(makeFundingFeeState('i1', now, 'binance', 'BTCUSDT'))

      bus.emit('ws.funding_fee', makeFundingEvent(now, 'bybit', 'BTCUSDT'))

      expect(exits).toHaveLength(0)
      // Timeout still fires normally
      timers[0]!.cb()
      expect(exits[0]?.reason).toBe('funding_fee_timeout')
    })

    it('ignores ws.funding_fee events where fundingTime is more than 5s before fundingTs', () => {
      const { bus, monitor, timers, exits } = makeMonitor()
      const now = Date.now()
      const state = makeFundingFeeState('i1', now)
      const fundingTs = (state.intent.exitPolicy as { fundingTs: number }).fundingTs
      monitor.arm(state)

      // fundingTime is 6s before fundingTs → outside tolerance window
      bus.emit('ws.funding_fee', makeFundingEvent(now, 'binance', 'BTCUSDT', fundingTs - 6_000))

      expect(exits).toHaveLength(0)
      timers[0]!.cb()
      expect(exits[0]?.reason).toBe('funding_fee_timeout')
    })

    it('fires only once if both WS event and timeout fire', () => {
      const { bus, monitor, timers, exits } = makeMonitor()
      const now = Date.now()
      monitor.arm(makeFundingFeeState('i1', now))

      bus.emit('ws.funding_fee', makeFundingEvent(now))
      timers[0]!.cb()

      expect(exits).toHaveLength(1)
      expect(exits[0]?.reason).toBe('funding_fee')
    })
  })
})
