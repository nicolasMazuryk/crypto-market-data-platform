import { describe, it, expect } from 'vitest'
import { computeDiff, computeFleetEntryHash, loadStrategyContents, type ObservedState } from '../reconcile.js'
import type { Fleet, FleetEntry } from '../schema.js'

function makeEntry(overrides: Partial<FleetEntry> = {}): FleetEntry {
  const base: FleetEntry = {
    id: 'strategy_3a-bybit',
    strategy: 'strategy_3a',
    exchange: 'bybit',
    enabled: true,
    strategy_config: 'live-configs/strategies/strategy_3a-bybit.yaml',
    runtime: { metrics_port: 9501, health_port: 9601, log_level: 'info' },
    risk: {},
  }
  return { ...base, ...overrides }
}

function makeFleet(entries: FleetEntry[]): Fleet {
  return { combinations: entries }
}

function makeObserved(overrides: Partial<ObservedState> = {}): ObservedState {
  return {
    runningIds: new Set(),
    deployedSha: null,
    configHashes: new Map(),
    ...overrides,
  }
}

const STRATEGY_CONTENT = 'strategies:\n  - id: strategy_3a\n    enabled: true\n'
const CODE_SHA = 'abc1234'

describe('computeDiff', () => {
  it('puts enabled entry not on server into toStart', () => {
    const fleet = makeFleet([makeEntry()])
    const observed = makeObserved({ runningIds: new Set() })
    const strategyContents = new Map([['strategy_3a-bybit', STRATEGY_CONTENT]])

    const diff = computeDiff(fleet, observed, CODE_SHA, strategyContents)

    expect(diff.toStart).toHaveLength(1)
    expect(diff.toStart[0]?.id).toBe('strategy_3a-bybit')
    expect(diff.toStop).toHaveLength(0)
    expect(diff.toRedeploy).toHaveLength(0)
    expect(diff.unchanged).toHaveLength(0)
  })

  it('puts running instance not in fleet into toStop', () => {
    const fleet = makeFleet([])
    const observed = makeObserved({ runningIds: new Set(['strategy_3a-bybit']) })
    const strategyContents = new Map<string, string>()

    const diff = computeDiff(fleet, observed, CODE_SHA, strategyContents)

    expect(diff.toStop).toContain('strategy_3a-bybit')
    expect(diff.toStart).toHaveLength(0)
  })

  it('puts disabled entry that is running into toStop', () => {
    const fleet = makeFleet([makeEntry({ enabled: false })])
    const observed = makeObserved({ runningIds: new Set(['strategy_3a-bybit']) })
    const strategyContents = new Map<string, string>()

    const diff = computeDiff(fleet, observed, CODE_SHA, strategyContents)

    expect(diff.toStop).toContain('strategy_3a-bybit')
  })

  it('marks unchanged when hash matches and code unchanged', () => {
    const entry = makeEntry()
    const hash = computeFleetEntryHash(entry, STRATEGY_CONTENT, CODE_SHA)
    const fleet = makeFleet([entry])
    const observed = makeObserved({
      runningIds: new Set(['strategy_3a-bybit']),
      deployedSha: CODE_SHA,
      configHashes: new Map([['strategy_3a-bybit', hash]]),
    })
    const strategyContents = new Map([['strategy_3a-bybit', STRATEGY_CONTENT]])

    const diff = computeDiff(fleet, observed, CODE_SHA, strategyContents)

    expect(diff.unchanged).toHaveLength(1)
    expect(diff.unchanged[0]?.id).toBe('strategy_3a-bybit')
    expect(diff.toRedeploy).toHaveLength(0)
  })

  it('marks toRedeploy when code SHA changed', () => {
    const entry = makeEntry()
    const oldHash = computeFleetEntryHash(entry, STRATEGY_CONTENT, 'old1234')
    const fleet = makeFleet([entry])
    const observed = makeObserved({
      runningIds: new Set(['strategy_3a-bybit']),
      deployedSha: 'old1234', // differs from local CODE_SHA
      configHashes: new Map([['strategy_3a-bybit', oldHash]]),
    })
    const strategyContents = new Map([['strategy_3a-bybit', STRATEGY_CONTENT]])

    const diff = computeDiff(fleet, observed, CODE_SHA, strategyContents)

    expect(diff.toRedeploy).toHaveLength(1)
    expect(diff.toRedeploy[0]?.id).toBe('strategy_3a-bybit')
    expect(diff.unchanged).toHaveLength(0)
  })

  it('marks toRedeploy when config hash differs (strategy config changed)', () => {
    const entry = makeEntry()
    const fleet = makeFleet([entry])
    const observed = makeObserved({
      runningIds: new Set(['strategy_3a-bybit']),
      deployedSha: CODE_SHA,
      configHashes: new Map([['strategy_3a-bybit', 'stale-hash']]),
    })
    const strategyContents = new Map([['strategy_3a-bybit', STRATEGY_CONTENT]])

    const diff = computeDiff(fleet, observed, CODE_SHA, strategyContents)

    expect(diff.toRedeploy).toHaveLength(1)
  })

  it('marks toRedeploy when no deployed hash found', () => {
    const entry = makeEntry()
    const fleet = makeFleet([entry])
    const observed = makeObserved({
      runningIds: new Set(['strategy_3a-bybit']),
      deployedSha: CODE_SHA,
      configHashes: new Map(), // no hash on file
    })
    const strategyContents = new Map([['strategy_3a-bybit', STRATEGY_CONTENT]])

    const diff = computeDiff(fleet, observed, CODE_SHA, strategyContents)

    expect(diff.toRedeploy).toHaveLength(1)
  })

  it('handles mixed fleet state correctly', () => {
    const bybit = makeEntry({
      id: 'strategy_3a-bybit',
      exchange: 'bybit',
      runtime: { metrics_port: 9501, health_port: 9601, log_level: 'info' },
    })
    const okx = makeEntry({
      id: 'strategy_3a-okx',
      exchange: 'okx',
      runtime: { metrics_port: 9502, health_port: 9602, log_level: 'info' },
    })
    const staleHash = 'stale-hash'

    const okxHash = computeFleetEntryHash(okx, STRATEGY_CONTENT, CODE_SHA)
    const fleet = makeFleet([bybit, okx])
    const observed = makeObserved({
      runningIds: new Set(['strategy_3a-bybit', 'strategy_3a-okx', 'strategy_3a-mexc']),
      deployedSha: CODE_SHA,
      configHashes: new Map([
        ['strategy_3a-bybit', staleHash],
        ['strategy_3a-okx', okxHash],
      ]),
    })
    const strategyContents = new Map([
      ['strategy_3a-bybit', STRATEGY_CONTENT],
      ['strategy_3a-okx', STRATEGY_CONTENT],
    ])

    const diff = computeDiff(fleet, observed, CODE_SHA, strategyContents)

    expect(diff.toRedeploy.map(e => e.id)).toContain('strategy_3a-bybit')
    expect(diff.unchanged.map(e => e.id)).toContain('strategy_3a-okx')
    expect(diff.toStop).toContain('strategy_3a-mexc')
    expect(diff.toStart).toHaveLength(0)
  })
})

describe('computeFleetEntryHash', () => {
  it('produces a 16-char hex string', () => {
    const hash = computeFleetEntryHash(makeEntry(), STRATEGY_CONTENT, CODE_SHA)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('produces different hashes for different strategy content', () => {
    const entry = makeEntry()
    const h1 = computeFleetEntryHash(entry, 'content-a', CODE_SHA)
    const h2 = computeFleetEntryHash(entry, 'content-b', CODE_SHA)
    expect(h1).not.toBe(h2)
  })

  it('produces different hashes for different code SHAs', () => {
    const entry = makeEntry()
    const h1 = computeFleetEntryHash(entry, STRATEGY_CONTENT, 'sha1')
    const h2 = computeFleetEntryHash(entry, STRATEGY_CONTENT, 'sha2')
    expect(h1).not.toBe(h2)
  })

  it('is deterministic', () => {
    const entry = makeEntry()
    const h1 = computeFleetEntryHash(entry, STRATEGY_CONTENT, CODE_SHA)
    const h2 = computeFleetEntryHash(entry, STRATEGY_CONTENT, CODE_SHA)
    expect(h1).toBe(h2)
  })
})

describe('loadStrategyContents', () => {
  it('throws when an enabled entry references a missing strategy_config file', () => {
    const fleet = makeFleet([makeEntry({ strategy_config: '/tmp/does-not-exist-strategy-config.yaml' })])

    expect(() => loadStrategyContents(fleet)).toThrow(/failed to load strategy_config/)
  })
})
