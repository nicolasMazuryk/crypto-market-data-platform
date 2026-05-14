import { describe, expect, it, vi } from 'vitest'

import type { MarketMetadata } from '../markets/types.js'
import type { MarketMetadataProvider } from '../markets/types.js'
import type { StateStore } from '../state/types.js'
import type { KillSwitch } from '../risk/types.js'
import type { RiskConfig } from '../config/types.js'
import type { TradeIntent } from '../strategies/types.js'
import type { PreflightDeps } from './preflight.js'
import { preflight } from './preflight.js'

function makeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
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
    nextFundingTimestamp: Date.now() + 28800000,
    nextFundingDatetime: new Date(Date.now() + 28800000).toISOString(),
    decidedAt: Date.now(),
    entryAt: Date.now() + 10000,
    exitPolicy: { kind: 'timed', exitAt: Date.now() + 30000 },
    ...overrides,
  }
}

function makeMarket(overrides: Partial<MarketMetadata> = {}): MarketMetadata {
  return {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    exchangeSymbol: 'BTCUSDT',
    contractSize: 1,
    pricePrecision: 2,
    amountPrecision: 0.0001,
    makerFee: 0.0002,
    takerFee: 0.0004,
    status: 'trading',
    ...overrides,
  }
}

function makeDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  const market = makeMarket()
  const markets: MarketMetadataProvider = {
    list: vi.fn().mockReturnValue([market]),
    get: vi.fn().mockReturnValue(market),
    resolve: vi.fn().mockReturnValue(undefined),
    refresh: vi.fn(),
    onUpdate: vi.fn().mockReturnValue(() => {}),
  }
  const state: StateStore = {
    orders: vi.fn().mockReturnValue([]),
    positions: vi.fn().mockReturnValue([]),
    balances: vi
      .fn()
      .mockReturnValue([{ exchange: 'binance', asset: 'USDT', available: 1000, locked: 0, updatedAt: 0 }]),
    reconcile: vi.fn(),
    onDesync: vi.fn().mockReturnValue(() => {}),
  }
  const killSwitch: KillSwitch = {
    state: vi.fn().mockReturnValue({ mode: 'dry_run' }),
    trip: vi.fn(),
    setMode: vi.fn(),
    flattenAll: vi.fn(),
    canPlaceOrder: vi.fn().mockReturnValue(true),
    wireFlattener: vi.fn(),
  }
  const risk: RiskConfig = {
    globalMaxConcurrentIntents: 10,
    globalMaxNotionalUsd: 1000,
    perStrategy: {
      strategy_1: { maxConcurrentIntents: 2, maxNotionalUsd: 200 },
    },
  }
  return {
    markets,
    state,
    killSwitch,
    risk,
    countIntents: vi.fn().mockReturnValue(0),
    notionalInFlight: vi.fn().mockReturnValue(0),
    ...overrides,
  }
}

describe('preflight', () => {
  it('returns ok with computed qty on valid intent', () => {
    const result = preflight(makeIntent(), 50000, makeDeps())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.qty).toBeGreaterThan(0)
    }
  })

  it('rejects when kill switch blocks', () => {
    const deps = makeDeps()
    vi.mocked(deps.killSwitch.canPlaceOrder).mockReturnValue(false)
    const result = preflight(makeIntent(), 50000, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('kill_switch')
  })

  it('rejects when market not found', () => {
    const deps = makeDeps()
    vi.mocked(deps.markets.get).mockReturnValue(undefined)
    const result = preflight(makeIntent(), 50000, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('no_market')
  })

  it('rejects when leverage exceeds market max', () => {
    const deps = makeDeps()
    vi.mocked(deps.markets.get).mockReturnValue(makeMarket({ maxLeverage: 2 }))
    const result = preflight(makeIntent({ leverage: 4 }), 50000, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('leverage_exceeded')
  })

  it('rejects when computed qty is null (precision too low for the price)', () => {
    // amountPrecision=0 means floor(0.0004) = 0 → null
    const deps = makeDeps()
    vi.mocked(deps.markets.get).mockReturnValue(makeMarket({ amountPrecision: 0 }))
    const result = preflight(makeIntent(), 50000, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid_qty')
  })

  it('rejects when insufficient balance', () => {
    const deps = makeDeps()
    vi.mocked(deps.state.balances).mockReturnValue([
      { exchange: 'binance', asset: 'USDT', available: 1, locked: 0, updatedAt: 0 },
    ])
    const result = preflight(makeIntent({ amountUsd: 20, leverage: 4 }), 50000, deps)
    // margin = 20/4 = 5, available = 1
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('insufficient_balance')
  })

  it('rejects when global concurrent intent cap reached', () => {
    const deps = makeDeps({ countIntents: vi.fn().mockReturnValue(10) })
    const result = preflight(makeIntent(), 50000, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('cap_exceeded')
  })

  it('rejects when global notional cap would be exceeded', () => {
    const deps = makeDeps({ notionalInFlight: vi.fn().mockReturnValue(990) })
    const result = preflight(makeIntent({ amountUsd: 20 }), 50000, deps)
    // 990 + 20 = 1010 > 1000
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('cap_exceeded')
  })

  it('rejects when per-strategy concurrent cap reached', () => {
    const deps = makeDeps({
      countIntents: vi.fn().mockImplementation(scope => {
        if (typeof scope === 'object' && 'strategy' in scope) return 2
        return 0
      }),
    })
    const result = preflight(makeIntent(), 50000, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('cap_exceeded')
  })
})
