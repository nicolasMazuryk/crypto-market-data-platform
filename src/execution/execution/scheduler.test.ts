import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Clock } from '../core/types.js'
import type { FundingRateSource, FundingSnapshot } from '../funding/types.js'
import type { SchedulerConfig } from '../config/types.js'
import type { StrategyConfig, StrategyId } from '../strategies/types.js'
import { createFundingEventScheduler } from './scheduler.js'

// At vi.setSystemTime(0), time is 00:00:00.000 UTC (epoch).
// With wakeBeforeHourEndMs=300_000 (5 min): nextHour=3_600_000, firstWake=3_300_000.
const FIRST_WAKE = 3_300_000
const WAKE_BEFORE = 300_000
const WINDOW_MS = 300_000

function makeSnapshot(
  symbol = 'BTCUSDT',
  nextFundingTimestamp = FIRST_WAKE + 60_000,
  timestamp = FIRST_WAKE - 10_000,
  fundingRatePercent = -0.5
): FundingSnapshot {
  return {
    exchange: 'binance',
    symbol,
    exchangeSymbol: symbol,
    fundingRate: fundingRatePercent / 100,
    fundingRatePercent,
    fundingInterval: 8,
    nextFundingTimestamp,
    nextFundingDatetime: new Date(nextFundingTimestamp).toISOString(),
    timestamp,
    markPrice: 50000,
  }
}

function makeConfig(entryOffsetSeconds = 10): Map<StrategyId, StrategyConfig> {
  return new Map([
    [
      'strategy_1',
      {
        id: 'strategy_1',
        enabled: true,
        negativeFundingThresholdPercent: -0.5,
        entryOffsetSeconds,
        exitOffsetSeconds: 2,
        amountUsd: 10,
        leverage: 5,
      } satisfies StrategyConfig,
    ],
  ])
}

function makeSchedulerConfig(overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
  return {
    wakeBeforeHourEndMs: WAKE_BEFORE,
    fundingWindowMs: WINDOW_MS,
    ...overrides,
  }
}

function makeFunding(latestMap: Map<string, FundingSnapshot>): FundingRateSource {
  return {
    latest: () => latestMap,
    onSnapshot: () => () => undefined,
    start: async () => Promise.resolve(),
    stop: async () => Promise.resolve(),
  }
}

function makeClock(): Clock {
  return {
    now: () => Date.now(),
    monotonic: () => Date.now(),
    skewMs: () => 0,
    recordSkew: () => undefined,
  }
}

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as never

describe('FundingEventScheduler (hourly wake)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('wakes at HH:55:00 and schedules qualifying symbols', () => {
    // Symbol whose nextFundingTimestamp is inside [FIRST_WAKE, FIRST_WAKE + WINDOW_MS]
    const nft = FIRST_WAKE + 60_000 // 1 min after wake
    const snap = makeSnapshot('BTCUSDT', nft)
    const latestMap = new Map([['BTCUSDT', snap]])
    const evaluateSpy = vi.fn()

    const scheduler = createFundingEventScheduler({
      clock: makeClock(),
      evaluator: {
        evaluate: (ex, sym) => {
          evaluateSpy(ex, sym)
          return []
        },
      },
      funding: makeFunding(latestMap),
      exchanges: ['binance'],
      configsByStrategy: makeConfig(10),
      config: makeSchedulerConfig(),
      evaluateLeadMs: 1500,
      logger: noopLogger,
    })

    // Before wake: evaluator not called
    vi.advanceTimersByTime(FIRST_WAKE - 1)
    expect(evaluateSpy).not.toHaveBeenCalled()

    // Wake fires at FIRST_WAKE; sub-timer = nft - 10_000 - 1_500 - FIRST_WAKE = 48_500
    vi.advanceTimersByTime(1) // now at FIRST_WAKE
    expect(evaluateSpy).not.toHaveBeenCalled() // sub-timer not yet fired

    vi.advanceTimersByTime(48_500)
    expect(evaluateSpy).toHaveBeenCalledWith('binance', 'BTCUSDT')

    scheduler.stop()
  })

  it('does not schedule symbols outside the funding window', () => {
    // Symbol with nextFunding 2 hours away — outside window
    const nft = FIRST_WAKE + WINDOW_MS + 1
    const snap = makeSnapshot('BTCUSDT', nft)
    const latestMap = new Map([['BTCUSDT', snap]])
    const evaluateSpy = vi.fn()

    const scheduler = createFundingEventScheduler({
      clock: makeClock(),
      evaluator: {
        evaluate: (ex, sym) => {
          evaluateSpy(ex, sym)
          return []
        },
      },
      funding: makeFunding(latestMap),
      exchanges: ['binance'],
      configsByStrategy: makeConfig(10),
      config: makeSchedulerConfig(),
      evaluateLeadMs: 1500,
      logger: noopLogger,
    })

    vi.advanceTimersByTime(FIRST_WAKE + WINDOW_MS + 100_000)
    expect(evaluateSpy).not.toHaveBeenCalled()

    scheduler.stop()
  })

  it('re-arms for the next hour after wake fires', () => {
    const latestMap = new Map<string, FundingSnapshot>()
    let wakeCount = 0
    // We can detect re-arms by putting a symbol in-window for the 2nd wake
    const secondWake = FIRST_WAKE + 3_600_000
    const nft2 = secondWake + 60_000
    const evaluateSpy = vi.fn()

    const scheduler = createFundingEventScheduler({
      clock: makeClock(),
      evaluator: {
        evaluate: (ex, sym) => {
          evaluateSpy(ex, sym)
          return []
        },
      },
      funding: {
        latest: () => {
          // Only expose the symbol after the first wake fires
          if (Date.now() >= FIRST_WAKE) {
            wakeCount++
          }
          return wakeCount >= 2 ? new Map([['ETHUSDT', makeSnapshot('ETHUSDT', nft2, Date.now() - 5_000)]]) : latestMap
        },
        onSnapshot: () => () => undefined,
        start: async () => Promise.resolve(),
        stop: async () => Promise.resolve(),
      },
      exchanges: ['binance'],
      configsByStrategy: makeConfig(10),
      config: makeSchedulerConfig(),
      evaluateLeadMs: 1500,
      logger: noopLogger,
    })

    // Advance past second wake + sub-timer
    vi.advanceTimersByTime(secondWake + 60_000)
    expect(evaluateSpy).toHaveBeenCalledWith('binance', 'ETHUSDT')

    scheduler.stop()
  })

  it('skips symbol when funding advanced before sub-timer fires', () => {
    const nft = FIRST_WAKE + 60_000
    const snap = makeSnapshot('BTCUSDT', nft)
    const advancedSnap = makeSnapshot('BTCUSDT', nft + 28_800_000)
    const latestMap = new Map([['BTCUSDT', snap]])
    const evaluateSpy = vi.fn()

    const scheduler = createFundingEventScheduler({
      clock: makeClock(),
      evaluator: {
        evaluate: (ex, sym) => {
          evaluateSpy(ex, sym)
          return []
        },
      },
      funding: makeFunding(latestMap),
      exchanges: ['binance'],
      configsByStrategy: makeConfig(10),
      config: makeSchedulerConfig(),
      evaluateLeadMs: 1500,
      logger: noopLogger,
    })

    // Advance to just before sub-timer fires; update the store to advanced snapshot
    vi.advanceTimersByTime(FIRST_WAKE)
    latestMap.set('BTCUSDT', advancedSnap)
    vi.advanceTimersByTime(100_000)
    expect(evaluateSpy).not.toHaveBeenCalled()

    scheduler.stop()
  })

  it('stop() cancels wake timer and eval timers', () => {
    const nft = FIRST_WAKE + 60_000
    const snap = makeSnapshot('BTCUSDT', nft)
    const latestMap = new Map([['BTCUSDT', snap]])
    const evaluateSpy = vi.fn()

    const scheduler = createFundingEventScheduler({
      clock: makeClock(),
      evaluator: {
        evaluate: (ex, sym) => {
          evaluateSpy(ex, sym)
          return []
        },
      },
      funding: makeFunding(latestMap),
      exchanges: ['binance'],
      configsByStrategy: makeConfig(10),
      config: makeSchedulerConfig(),
      evaluateLeadMs: 1500,
      logger: noopLogger,
    })

    scheduler.stop()
    vi.advanceTimersByTime(FIRST_WAKE + 200_000)
    expect(evaluateSpy).not.toHaveBeenCalled()
  })

  it('only schedules symbols in the allowlist', () => {
    const nft = FIRST_WAKE + 60_000
    const btc = makeSnapshot('BTCUSDT', nft)
    const eth = makeSnapshot('ETHUSDT', nft)
    const latestMap = new Map([
      ['BTCUSDT', btc],
      ['ETHUSDT', eth],
    ])
    const evaluateSpy = vi.fn()

    const scheduler = createFundingEventScheduler({
      clock: makeClock(),
      evaluator: {
        evaluate: (ex, sym) => {
          evaluateSpy(ex, sym)
          return []
        },
      },
      funding: makeFunding(latestMap),
      exchanges: ['binance'],
      configsByStrategy: makeConfig(10),
      config: makeSchedulerConfig(),
      symbolFilter: new Set(['ETHUSDT']),
      evaluateLeadMs: 1500,
      logger: noopLogger,
    })

    vi.advanceTimersByTime(FIRST_WAKE + 200_000)
    expect(evaluateSpy).toHaveBeenCalledTimes(1)
    expect(evaluateSpy).toHaveBeenCalledWith('binance', 'ETHUSDT')

    scheduler.stop()
  })

  it('schedules symbol at nextFundingTimestamp exactly at window boundary (inclusive)', () => {
    const nft = FIRST_WAKE + WINDOW_MS // exactly at window end
    const snap = makeSnapshot('BTCUSDT', nft)
    const latestMap = new Map([['BTCUSDT', snap]])
    const evaluateSpy = vi.fn()

    const scheduler = createFundingEventScheduler({
      clock: makeClock(),
      evaluator: {
        evaluate: (ex, sym) => {
          evaluateSpy(ex, sym)
          return []
        },
      },
      funding: makeFunding(latestMap),
      exchanges: ['binance'],
      configsByStrategy: makeConfig(10),
      config: makeSchedulerConfig(),
      evaluateLeadMs: 1500,
      logger: noopLogger,
    })

    vi.advanceTimersByTime(FIRST_WAKE + WINDOW_MS + 100_000)
    expect(evaluateSpy).toHaveBeenCalledWith('binance', 'BTCUSDT')

    scheduler.stop()
  })

  it('only schedules negative-threshold symbols that pass or are within 0.1 percentage points', () => {
    const nft = FIRST_WAKE + 60_000
    const latestMap = new Map([
      ['PASSUSDT', makeSnapshot('PASSUSDT', nft, FIRST_WAKE - 10_000, -0.5)],
      ['NEARUSDT', makeSnapshot('NEARUSDT', nft, FIRST_WAKE - 10_000, -0.41)],
      ['FARUSDT', makeSnapshot('FARUSDT', nft, FIRST_WAKE - 10_000, -0.39)],
    ])
    const evaluateSpy = vi.fn()
    const prewarmSpy = vi.fn()

    const scheduler = createFundingEventScheduler({
      clock: makeClock(),
      evaluator: {
        evaluate: (ex, sym) => {
          evaluateSpy(ex, sym)
          return []
        },
      },
      funding: makeFunding(latestMap),
      exchanges: ['binance'],
      configsByStrategy: makeConfig(10),
      config: makeSchedulerConfig(),
      evaluateLeadMs: 1500,
      leveragePrewarmer: prewarmSpy,
      logger: noopLogger,
    })

    vi.advanceTimersByTime(FIRST_WAKE + 100_000)

    expect(evaluateSpy).toHaveBeenCalledWith('binance', 'PASSUSDT')
    expect(evaluateSpy).toHaveBeenCalledWith('binance', 'NEARUSDT')
    expect(evaluateSpy).not.toHaveBeenCalledWith('binance', 'FARUSDT')
    expect(prewarmSpy).toHaveBeenCalledTimes(2)

    scheduler.stop()
  })

  it('handles positive and zero thresholds when filtering candidates', () => {
    const nft = FIRST_WAKE + 60_000
    const latestMap = new Map([
      ['POSPASS', makeSnapshot('POSPASS', nft, FIRST_WAKE - 10_000, 0.5)],
      ['POSNEAR', makeSnapshot('POSNEAR', nft, FIRST_WAKE - 10_000, 0.41)],
      ['POSFAR', makeSnapshot('POSFAR', nft, FIRST_WAKE - 10_000, 0.39)],
      ['ANYRATE', makeSnapshot('ANYRATE', nft, FIRST_WAKE - 10_000, -0.01)],
    ])
    const evaluateSpy = vi.fn()
    const configs = new Map<StrategyId, StrategyConfig>([
      [
        'strategy_6',
        {
          id: 'strategy_6',
          enabled: true,
          mainSide: 'long',
          funding_threshold: 0.5,
          entryOffsetSeconds: 10,
          fundingFeeTimeoutSeconds: 10,
          tpMultiplier: 1,
          slMultiplier: 1,
          deadlineSeconds: 300,
          mainAmountUsd: 10,
          leverage: 5,
        },
      ],
    ])

    let scheduler = createFundingEventScheduler({
      clock: makeClock(),
      evaluator: {
        evaluate: (ex, sym) => {
          evaluateSpy(ex, sym)
          return []
        },
      },
      funding: makeFunding(latestMap),
      exchanges: ['binance'],
      configsByStrategy: configs,
      config: makeSchedulerConfig(),
      evaluateLeadMs: 1500,
      logger: noopLogger,
    })

    vi.advanceTimersByTime(FIRST_WAKE + 100_000)

    expect(evaluateSpy).toHaveBeenCalledWith('binance', 'POSPASS')
    expect(evaluateSpy).toHaveBeenCalledWith('binance', 'POSNEAR')
    expect(evaluateSpy).not.toHaveBeenCalledWith('binance', 'POSFAR')
    expect(evaluateSpy).not.toHaveBeenCalledWith('binance', 'ANYRATE')
    scheduler.stop()

    evaluateSpy.mockClear()
    vi.setSystemTime(0)
    configs.set('strategy_6', { ...(configs.get('strategy_6') as Extract<StrategyConfig, { id: 'strategy_6' }>), funding_threshold: 0 })
    scheduler = createFundingEventScheduler({
      clock: makeClock(),
      evaluator: {
        evaluate: (ex, sym) => {
          evaluateSpy(ex, sym)
          return []
        },
      },
      funding: makeFunding(latestMap),
      exchanges: ['binance'],
      configsByStrategy: configs,
      config: makeSchedulerConfig(),
      evaluateLeadMs: 1500,
      logger: noopLogger,
    })

    vi.advanceTimersByTime(FIRST_WAKE + 100_000)
    expect(evaluateSpy).toHaveBeenCalledWith('binance', 'ANYRATE')
    scheduler.stop()
  })
})

describe('FundingEventScheduler with fundingTimeOverrideMs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires handleWake immediately (not at HH:55) and schedules eval at override - entryOffset - lead', () => {
    const overrideMs = 5 * 60_000 // 5 min from now, well inside a 10-min window
    const entryOffsetSeconds = 10
    const leadMs = 1500
    const snap = makeSnapshot('BTCUSDT', overrideMs)
    const latestMap = new Map([['BTCUSDT', snap]])
    const evaluateSpy = vi.fn()

    const scheduler = createFundingEventScheduler({
      clock: makeClock(),
      evaluator: {
        evaluate: (ex, sym) => {
          evaluateSpy(ex, sym)
          return []
        },
      },
      funding: makeFunding(latestMap),
      exchanges: ['binance'],
      configsByStrategy: makeConfig(entryOffsetSeconds),
      config: makeSchedulerConfig({ fundingWindowMs: 10 * 60_000 }),
      evaluateLeadMs: leadMs,
      fundingTimeOverrideMs: overrideMs,
      logger: noopLogger,
    })

    // Override fires immediately; eval timer = overrideMs - entryOffsetMs - leadMs - now
    const expectedEvalAt = overrideMs - entryOffsetSeconds * 1000 - leadMs

    vi.advanceTimersByTime(expectedEvalAt - 1)
    expect(evaluateSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(evaluateSpy).toHaveBeenCalledWith('binance', 'BTCUSDT')

    // Advance past FIRST_WAKE to confirm hourly wake was not armed
    vi.advanceTimersByTime(FIRST_WAKE)
    expect(evaluateSpy).toHaveBeenCalledTimes(1)

    scheduler.stop()
  })

  it('does not re-arm the hourly wake timer after override fires', () => {
    const overrideMs = 5 * 60_000
    // ETHUSDT's nextFundingTimestamp is inside the normal hourly window but NOT the override window.
    // If the hourly wake re-armed, it would schedule ETHUSDT; if not, it won't be evaluated.
    const hourlySnap = makeSnapshot('ETHUSDT', FIRST_WAKE + 60_000)
    const latestMap = new Map([['ETHUSDT', hourlySnap]])
    const evaluateSpy = vi.fn()

    const scheduler = createFundingEventScheduler({
      clock: makeClock(),
      evaluator: {
        evaluate: (ex, sym) => {
          evaluateSpy(ex, sym)
          return []
        },
      },
      funding: makeFunding(latestMap),
      exchanges: ['binance'],
      configsByStrategy: makeConfig(10),
      config: makeSchedulerConfig({ fundingWindowMs: 10 * 60_000 }),
      fundingTimeOverrideMs: overrideMs,
      logger: noopLogger,
    })

    // Advance past FIRST_WAKE plus eval window for ETHUSDT
    vi.advanceTimersByTime(FIRST_WAKE + 200_000)

    // ETHUSDT was not in the override window so was not scheduled; hourly wake suppressed
    expect(evaluateSpy).not.toHaveBeenCalledWith('binance', 'ETHUSDT')

    scheduler.stop()
  })

  it('throws if override is further away than fundingWindowMs', () => {
    const overrideMs = 20 * 60_000 // 20 min, outside default 10-min window
    const latestMap = new Map<string, FundingSnapshot>()

    expect(() => {
      createFundingEventScheduler({
        clock: makeClock(),
        evaluator: { evaluate: () => [] },
        funding: makeFunding(latestMap),
        exchanges: ['binance'],
        configsByStrategy: makeConfig(10),
        config: makeSchedulerConfig({ fundingWindowMs: 10 * 60_000 }),
        fundingTimeOverrideMs: overrideMs,
        logger: noopLogger,
      })
    }).toThrow(/fundingWindowMs/)
  })

  it('leveragePrewarmer is called once per (exchange, symbol, leverage) for each scheduled candidate', () => {
    const overrideMs = 5 * 60_000
    const btc = makeSnapshot('BTCUSDT', overrideMs)
    const eth = makeSnapshot('ETHUSDT', overrideMs)
    const latestMap = new Map([
      ['BTCUSDT', btc],
      ['ETHUSDT', eth],
    ])
    const prewarmSpy = vi.fn()
    const configs = new Map([
      [
        'strategy_1',
        {
          id: 'strategy_1',
          enabled: true,
          negativeFundingThresholdPercent: -0.5,
          entryOffsetSeconds: 10,
          exitOffsetSeconds: 2,
          amountUsd: 10,
          leverage: 5,
        } satisfies StrategyConfig,
      ],
    ])

    const scheduler = createFundingEventScheduler({
      clock: makeClock(),
      evaluator: { evaluate: () => [] },
      funding: makeFunding(latestMap),
      exchanges: ['binance'],
      configsByStrategy: configs,
      config: makeSchedulerConfig({ fundingWindowMs: 10 * 60_000 }),
      fundingTimeOverrideMs: overrideMs,
      leveragePrewarmer: prewarmSpy,
      logger: noopLogger,
    })

    // leveragePrewarmer should be called once per symbol × leverage (2 symbols × 1 leverage)
    expect(prewarmSpy).toHaveBeenCalledTimes(2)
    expect(prewarmSpy).toHaveBeenCalledWith('binance', 'BTCUSDT', 5)
    expect(prewarmSpy).toHaveBeenCalledWith('binance', 'ETHUSDT', 5)

    scheduler.stop()
  })
})
