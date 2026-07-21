import { describe, expect, it, vi } from 'vitest'

import { ConfigError, parseEngineConfig } from './schema.js'

function baseRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'dry_run',
    exchanges: [],
    strategies: [],
    observability: { metricsPort: 9464, tracing: { enabled: false } },
    ...overrides,
  }
}

function strategy6Raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'strategy_6',
    mainSide: 'long',
    mainAmountUsd: 10,
    leverage: 5,
    ...overrides,
  }
}

describe('migrateLegacyStrategyKeys (via parseEngineConfig)', () => {
  it('legacy funding_threshold on strategy_6 loads, warns once, and resolves to fundingThresholdPercent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const cfg = parseEngineConfig(baseRaw({ strategies: [strategy6Raw({ funding_threshold: -0.4 })] }))
    const s6 = cfg.strategies.find(s => s.id === 'strategy_6')
    expect(s6 && 'fundingThresholdPercent' in s6 ? s6.fundingThresholdPercent : undefined).toBe(-0.4)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it('canonical fundingThresholdPercent on strategy_6 loads clean, no warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const cfg = parseEngineConfig(baseRaw({ strategies: [strategy6Raw({ fundingThresholdPercent: 0.1 })] }))
    const s6 = cfg.strategies.find(s => s.id === 'strategy_6')
    expect(s6 && 'fundingThresholdPercent' in s6 ? s6.fundingThresholdPercent : undefined).toBe(0.1)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('throws ConfigError when both legacy and canonical keys are present', () => {
    expect(() =>
      parseEngineConfig(
        baseRaw({
          strategies: [strategy6Raw({ funding_threshold: -0.4, fundingThresholdPercent: 0.1 })],
        })
      )
    ).toThrow(ConfigError)
  })
})

describe('parseTestingConfig (via parseEngineConfig)', () => {
  it('returns no testing config when testing key is absent', () => {
    const cfg = parseEngineConfig(baseRaw())
    expect(cfg.testing).toBeUndefined()
  })

  it('returns no testing config when fundingTimeOverride is absent', () => {
    const cfg = parseEngineConfig(baseRaw({ testing: {} }))
    expect(cfg.testing).toBeUndefined()
  })

  it('resolves HH:MM:SS to next future occurrence (today)', () => {
    // Use a fixed "now" just before 12:00:00 UTC
    const now = Date.UTC(2024, 0, 15, 11, 59, 0, 0) // 2024-01-15 11:59:00 UTC
    const cfg = parseEngineConfig(
      baseRaw({
        testing: { fundingTimeOverride: { time: '12:00:00' } },
      }),
      now
    )
    const expected = Date.UTC(2024, 0, 15, 12, 0, 0, 0)
    expect(cfg.testing?.fundingTimeOverride?.resolvedMs).toBe(expected)
  })

  it('resolves HH:MM:SS to tomorrow when time has already passed today', () => {
    // now is 12:01:00 UTC, requesting 12:00:00 → should resolve to tomorrow
    const now = Date.UTC(2024, 0, 15, 12, 1, 0, 0)
    const cfg = parseEngineConfig(
      baseRaw({
        testing: { fundingTimeOverride: { time: '12:00:00' } },
      }),
      now
    )
    const expected = Date.UTC(2024, 0, 16, 12, 0, 0, 0)
    expect(cfg.testing?.fundingTimeOverride?.resolvedMs).toBe(expected)
  })

  it('timestampMs takes precedence over time string', () => {
    const now = Date.UTC(2024, 0, 15, 0, 0, 0, 0)
    const tsMs = now + 30 * 60_000
    const cfg = parseEngineConfig(
      baseRaw({
        testing: { fundingTimeOverride: { time: '01:00:00', timestampMs: tsMs } },
      }),
      now
    )
    expect(cfg.testing?.fundingTimeOverride?.resolvedMs).toBe(tsMs)
  })

  it('records source as cli when source field is cli', () => {
    const now = Date.UTC(2024, 0, 15, 0, 0, 0, 0)
    const cfg = parseEngineConfig(
      baseRaw({
        testing: { fundingTimeOverride: { time: '01:00:00', source: 'cli' } },
      }),
      now
    )
    expect(cfg.testing?.fundingTimeOverride?.source).toBe('cli')
  })

  it('defaults source to yaml when source field is absent', () => {
    const now = Date.UTC(2024, 0, 15, 0, 0, 0, 0)
    const cfg = parseEngineConfig(
      baseRaw({
        testing: { fundingTimeOverride: { time: '01:00:00' } },
      }),
      now
    )
    expect(cfg.testing?.fundingTimeOverride?.source).toBe('yaml')
  })

  it('throws ConfigError when override is more than 1h in the past', () => {
    const now = Date.UTC(2024, 0, 15, 12, 0, 0, 0)
    const pastMs = now - 3_600_001
    expect(() =>
      parseEngineConfig(baseRaw({ testing: { fundingTimeOverride: { timestampMs: pastMs } } }), now)
    ).toThrow(ConfigError)
  })

  it('throws ConfigError when override is more than 24h in the future', () => {
    const now = Date.UTC(2024, 0, 15, 0, 0, 0, 0)
    const futureMs = now + 86_400_001
    expect(() =>
      parseEngineConfig(baseRaw({ testing: { fundingTimeOverride: { timestampMs: futureMs } } }), now)
    ).toThrow(ConfigError)
  })

  it('throws ConfigError for invalid HH:MM:SS format', () => {
    const now = Date.UTC(2024, 0, 15, 0, 0, 0, 0)
    expect(() => parseEngineConfig(baseRaw({ testing: { fundingTimeOverride: { time: '25:00:00' } } }), now)).toThrow(
      ConfigError
    )
  })

  it('throws ConfigError in live mode without acknowledgeLiveOverride', () => {
    const now = Date.UTC(2024, 0, 15, 0, 0, 0, 0)
    expect(() =>
      parseEngineConfig(
        baseRaw({
          mode: 'live',
          testing: {
            fundingTimeOverride: {
              time: '01:00:00',
              acknowledgeLiveOverride: false,
            },
          },
          risk: { acknowledgeUncapped: true },
        }),
        now
      )
    ).toThrow(ConfigError)
  })

  it('accepts live mode with acknowledgeLiveOverride: true', () => {
    const now = Date.UTC(2024, 0, 15, 0, 0, 0, 0)
    expect(() =>
      parseEngineConfig(
        baseRaw({
          mode: 'live',
          testing: {
            fundingTimeOverride: {
              time: '01:00:00',
              acknowledgeLiveOverride: true,
            },
          },
          risk: { acknowledgeUncapped: true },
        }),
        now
      )
    ).not.toThrow()
  })
})

describe('LONG/SHORT co-run guard (§11.1)', () => {
  function strategy1Raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'strategy_1',
      enabled: true,
      negativeFundingThresholdPercent: -0.1,
      entryOffsetSeconds: 3,
      exitOffsetSeconds: 6,
      amountUsd: 10,
      leverage: 5,
      ...overrides,
    }
  }

  function strategy3aRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'strategy_3a',
      enabled: true,
      negativeFundingThresholdPercent: -0.1,
      entryOffsetSeconds: 3,
      stopLossPercent: 1.0,
      tpVariantAMultiplier: 1.5,
      tpVariantBOffsetPercent: 0.3,
      deadlineSeconds: 900,
      amountUsd: 10,
      leverage: 5,
      ...overrides,
    }
  }

  function strategy6Raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'strategy_6',
      enabled: true,
      mainSide: 'long',
      mainAmountUsd: 10,
      leverage: 5,
      ...overrides,
    }
  }

  it('rejects strategy_3a + strategy_1 both enabled (SHORT vs LONG)', () => {
    expect(() =>
      parseEngineConfig(baseRaw({ strategies: [strategy1Raw(), strategy3aRaw()] }))
    ).toThrow(ConfigError)
  })

  it('allows strategy_3a + strategy_6 both enabled (strategy_6 exempt from the guard)', () => {
    expect(() =>
      parseEngineConfig(baseRaw({ strategies: [strategy6Raw(), strategy3aRaw()] }))
    ).not.toThrow()
  })
})
