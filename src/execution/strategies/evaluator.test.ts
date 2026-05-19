import { describe, expect, it, vi } from 'vitest'

import { createEventBus } from '../core/bus.js'
import { createClock } from '../core/clock.js'
import { createExecutionLogger } from '../core/logger.js'
import type { FundingSnapshot } from '../funding/types.js'
import type { MarketMetadataProvider } from '../markets/types.js'
import { MetricsRegistry, registerExecutionMetrics } from '../observability/metrics.js'
import type { EvalContext, StrategyConfig, StrategyRule, TradeIntent } from './types.js'
import { createStrategyRegistry } from './registry.js'
import { createStrategyEvaluator } from './evaluator.js'

function makeSnap(symbol: string, fundingRatePercent: number, ts: number): FundingSnapshot {
  return {
    exchange: 'binance',
    symbol,
    exchangeSymbol: symbol,
    fundingRate: fundingRatePercent / 100,
    fundingRatePercent,
    fundingInterval: 8,
    nextFundingTimestamp: ts + 28800000,
    nextFundingDatetime: new Date(ts + 28800000).toISOString(),
    timestamp: ts,
  }
}

function makeIntent(symbol: string, strategy: 'strategy_1', ts: number): TradeIntent {
  return {
    id: `intent-${symbol}`,
    strategy,
    exchange: 'binance',
    symbol,
    exchangeSymbol: symbol,
    side: 'long',
    amountUsd: 10,
    leverage: 5,
    volume: 0,
    fundingRate: -0.006,
    fundingRatePercent: -0.6,
    fundingInterval: 8,
    nextFundingTimestamp: ts + 28800000,
    nextFundingDatetime: new Date(ts + 28800000).toISOString(),
    decidedAt: ts,
    entryAt: ts + 10000,
    exitPolicy: { kind: 'timed', exitAt: ts + 30000 },
  }
}

function makeRule(intentsToReturn: TradeIntent[]): StrategyRule {
  return {
    id: 'strategy_1',
    evaluate: vi.fn().mockReturnValue(intentsToReturn),
  }
}

function makeMarkets(): MarketMetadataProvider {
  return {
    list: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(undefined),
    resolve: vi.fn().mockReturnValue(undefined),
    refresh: vi.fn(),
    onUpdate: vi.fn().mockReturnValue(() => {}),
  }
}

describe('StrategyEvaluator', () => {
  it('calls enabled rule and emits intent.decided for each intent', () => {
    const bus = createEventBus()
    const clock = createClock()
    const registry = createStrategyRegistry()
    const registry_ = new MetricsRegistry()
    const metrics = registerExecutionMetrics(registry_)
    const now = clock.now()

    const intents = [makeIntent('BTCUSDT', 'strategy_1', now)]
    const rule = makeRule(intents)
    registry.register(rule)

    const snapshots = new Map([['BTCUSDT', makeSnap('BTCUSDT', -0.6, now)]])

    const config: StrategyConfig = {
      id: 'strategy_1',
      enabled: true,
      negativeFundingThresholdPercent: 0.5,
      entryOffsetSeconds: 10,
      exitOffsetSeconds: 2,
      amountUsd: 10,
      leverage: 5,
    }

    const decided: TradeIntent[] = []
    bus.on('intent.decided', intent => decided.push(intent))

    const evaluator = createStrategyEvaluator({
      bus,
      clock,
      logger: createExecutionLogger(),
      metrics,
      registry,
      funding: {
        latest: () => snapshots,
        onSnapshot: vi.fn().mockReturnValue(() => {}),
        start: vi.fn(),
        stop: vi.fn(),
      },
      markets: makeMarkets(),
      configsByStrategy: new Map([['strategy_1', config]]),
    })

    const result = evaluator.evaluate('binance', 'BTCUSDT')

    expect(result).toHaveLength(1)
    expect(decided).toHaveLength(1)
    expect(decided[0]!.symbol).toBe('BTCUSDT')
    expect(rule.evaluate).toHaveBeenCalledOnce()
  })

  it('builds EvalContext with correct fields and passes to rule', () => {
    const bus = createEventBus()
    const clock = createClock()
    const registry = createStrategyRegistry()
    const metricReg = new MetricsRegistry()
    const metrics = registerExecutionMetrics(metricReg)
    const now = clock.now()

    let capturedCtx: EvalContext | undefined
    const rule: StrategyRule = {
      id: 'strategy_1',
      evaluate: ctx => {
        capturedCtx = ctx
        return []
      },
    }
    registry.register(rule)

    const snapshots = new Map([['BTCUSDT', makeSnap('BTCUSDT', -0.6, now)]])
    const config: StrategyConfig = {
      id: 'strategy_1',
      enabled: true,
      negativeFundingThresholdPercent: 0.5,
      entryOffsetSeconds: 10,
      exitOffsetSeconds: 2,
      amountUsd: 10,
      leverage: 5,
    }

    const evaluator = createStrategyEvaluator({
      bus,
      clock,
      logger: createExecutionLogger(),
      metrics,
      registry,
      funding: {
        latest: () => snapshots,
        onSnapshot: vi.fn().mockReturnValue(() => {}),
        start: vi.fn(),
        stop: vi.fn(),
      },
      markets: makeMarkets(),
      configsByStrategy: new Map([['strategy_1', config]]),
    })

    evaluator.evaluate('binance', 'BTCUSDT')

    expect(capturedCtx).toBeDefined()
    expect(capturedCtx!.exchange).toBe('binance')
    expect(capturedCtx!.fundingEvent.symbol).toBe('BTCUSDT')
    expect(capturedCtx!.config).toBe(config)
    expect(capturedCtx!.snapshots).toBe(snapshots)
  })

  it('deduplicates intents with same (strategy, exchange, symbol, nextFundingTimestamp)', () => {
    const bus = createEventBus()
    const clock = createClock()
    const registry = createStrategyRegistry()
    const metricReg = new MetricsRegistry()
    const metrics = registerExecutionMetrics(metricReg)
    const now = clock.now()
    const ts = now + 28800000

    const dup = makeIntent('BTCUSDT', 'strategy_1', now)
    // Force same nextFundingTimestamp
    dup.nextFundingTimestamp = ts
    const dup2 = { ...dup, id: 'intent-2' }

    registry.register(makeRule([dup, dup2]))

    const snapshots = new Map([['BTCUSDT', makeSnap('BTCUSDT', -0.6, now)]])
    const config: StrategyConfig = {
      id: 'strategy_1',
      enabled: true,
      negativeFundingThresholdPercent: 0.5,
      entryOffsetSeconds: 10,
      exitOffsetSeconds: 2,
      amountUsd: 10,
      leverage: 5,
    }

    const decided: TradeIntent[] = []
    bus.on('intent.decided', intent => decided.push(intent))

    const evaluator = createStrategyEvaluator({
      bus,
      clock,
      logger: createExecutionLogger(),
      metrics,
      registry,
      funding: {
        latest: () => snapshots,
        onSnapshot: vi.fn().mockReturnValue(() => {}),
        start: vi.fn(),
        stop: vi.fn(),
      },
      markets: makeMarkets(),
      configsByStrategy: new Map([['strategy_1', config]]),
    })

    const result = evaluator.evaluate('binance', 'BTCUSDT')

    expect(result).toHaveLength(1)
    expect(decided).toHaveLength(1)
  })

  it('skips disabled rules', () => {
    const bus = createEventBus()
    const clock = createClock()
    const registry = createStrategyRegistry()
    const metricReg = new MetricsRegistry()
    const metrics = registerExecutionMetrics(metricReg)
    const now = clock.now()

    const rule = makeRule([makeIntent('BTCUSDT', 'strategy_1', now)])
    registry.register(rule)

    const snapshots = new Map([['BTCUSDT', makeSnap('BTCUSDT', -0.6, now)]])
    const disabledConfig: StrategyConfig = {
      id: 'strategy_1',
      enabled: false,
      negativeFundingThresholdPercent: 0.5,
      entryOffsetSeconds: 10,
      exitOffsetSeconds: 2,
      amountUsd: 10,
      leverage: 5,
    }

    const evaluator = createStrategyEvaluator({
      bus,
      clock,
      logger: createExecutionLogger(),
      metrics,
      registry,
      funding: {
        latest: () => snapshots,
        onSnapshot: vi.fn().mockReturnValue(() => {}),
        start: vi.fn(),
        stop: vi.fn(),
      },
      markets: makeMarkets(),
      configsByStrategy: new Map([['strategy_1', disabledConfig]]),
    })

    const result = evaluator.evaluate('binance', 'BTCUSDT')
    expect(result).toHaveLength(0)
    expect(rule.evaluate).not.toHaveBeenCalled()
  })

  it('returns empty when funding snapshot not found for trigger symbol', () => {
    const bus = createEventBus()
    const clock = createClock()
    const registry = createStrategyRegistry()
    const metricReg = new MetricsRegistry()
    const metrics = registerExecutionMetrics(metricReg)

    const evaluator = createStrategyEvaluator({
      bus,
      clock,
      logger: createExecutionLogger(),
      metrics,
      registry,
      funding: {
        latest: () => new Map(),
        onSnapshot: vi.fn().mockReturnValue(() => {}),
        start: vi.fn(),
        stop: vi.fn(),
      },
      markets: makeMarkets(),
      configsByStrategy: new Map(),
    })

    expect(evaluator.evaluate('binance', 'UNKNOWNUSDT')).toHaveLength(0)
  })

  it('returns empty when trigger symbol is not in the allowlist', () => {
    const bus = createEventBus()
    const clock = createClock()
    const registry = createStrategyRegistry()
    const metricReg = new MetricsRegistry()
    const metrics = registerExecutionMetrics(metricReg)
    const now = clock.now()

    const rule = makeRule([makeIntent('BTCUSDT', 'strategy_1', now)])
    registry.register(rule)

    const snapshots = new Map([['BTCUSDT', makeSnap('BTCUSDT', -0.6, now)]])
    const config: StrategyConfig = {
      id: 'strategy_1',
      enabled: true,
      negativeFundingThresholdPercent: 0.5,
      entryOffsetSeconds: 10,
      exitOffsetSeconds: 2,
      amountUsd: 10,
      leverage: 5,
    }

    const evaluator = createStrategyEvaluator({
      bus,
      clock,
      logger: createExecutionLogger(),
      metrics,
      registry,
      funding: {
        latest: () => snapshots,
        onSnapshot: vi.fn().mockReturnValue(() => {}),
        start: vi.fn(),
        stop: vi.fn(),
      },
      markets: makeMarkets(),
      configsByStrategy: new Map([['strategy_1', config]]),
      symbolFilter: new Set(['ETHUSDT']),
    })

    expect(evaluator.evaluate('binance', 'BTCUSDT')).toHaveLength(0)
    expect(rule.evaluate).not.toHaveBeenCalled()
  })
})
