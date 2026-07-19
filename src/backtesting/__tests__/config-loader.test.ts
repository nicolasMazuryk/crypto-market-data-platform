import { describe, it, expect } from 'vitest'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { loadConfig } from '../config/loader.js'

const BASE_CONFIG = path.join(process.cwd(), 'config', 'base_config.yaml')

describe('Config Loader', () => {
  it('loads strategy_1 config correctly', () => {
    const stratPath = path.join(process.cwd(), 'config', 'strategies', 'strategy_1.yaml')
    const config = loadConfig(stratPath, BASE_CONFIG)

    expect(config.base.exchange).toBe('binance')
    expect(config.base.symbol).toBeUndefined()
    expect(config.base.fees.binance).toBeDefined()
    expect(config.base.validation.required_seconds_before).toBe(3)

    expect(config.strategy.strategy_id).toBe('strategy_1')
    if (config.strategy.strategy_id === 'strategy_1') {
      expect(config.strategy.negative_funding_threshold_percent).toBe(-1.1)
      expect(config.strategy.entry_offset_seconds).toBe(5)
      expect(config.strategy.exit_offset_seconds).toBe(5)
      expect(config.strategy.amount_usd).toBe(20)
      expect(config.strategy.leverage).toBe(4)
    }
  })

  it('loads strategy_3a config with TP mode A', () => {
    const stratPath = path.join(process.cwd(), 'config', 'strategies', 'strategy_3a.yaml')
    const config = loadConfig(stratPath, BASE_CONFIG)

    expect(config.strategy.strategy_id).toBe('strategy_3a')
    if (config.strategy.strategy_id === 'strategy_3a') {
      expect(config.strategy.tp_mode).toBe('A')
      expect(config.strategy.tp_multiplier).toBe(1.975)
      expect(config.strategy.direction).toBe('short')
    }
  })

  it('loads strategy_4_1a config with funding_applied_on_same_second=false', () => {
    const stratPath = path.join(process.cwd(), 'config', 'strategies', 'strategy_4_1a.yaml')
    const config = loadConfig(stratPath, BASE_CONFIG)

    if (config.strategy.strategy_id === 'strategy_4_1a') {
      expect(config.strategy.funding_applied_on_same_second).toBe(false)
      expect(config.strategy.ladder_count).toBe(5)
    }
  })

  it('merges strategy overrides over base config', () => {
    const stratPath = path.join(process.cwd(), 'config', 'strategies', 'strategy_1.yaml')
    const config = loadConfig(stratPath, BASE_CONFIG)

    // Strategy-level fields override base
    expect(config.strategy.strategy_id).toBe('strategy_1')
    // Base fields still present
    expect(config.base.fees.binance?.taker_fee).toBe(0.0005)
  })

  it('throws for non-existent base config', () => {
    const stratPath = path.join(process.cwd(), 'config', 'strategies', 'strategy_1.yaml')
    expect(() => loadConfig(stratPath, '/nonexistent/path.yaml')).toThrow('Base config not found')
  })

  it('throws for non-existent strategy config', () => {
    expect(() => loadConfig('/nonexistent/strategy.yaml', BASE_CONFIG)).toThrow('Strategy config not found')
  })

  // Numeric-range bounds (e.g. entry_offset_seconds 1..5, deadline_seconds 5..900) are
  // intentionally NOT enforced by the generated schema yet — Task 06 layers those on via
  // the `bounds` data on CANONICAL_PARAMS. Only structural constraints that already
  // existed on the live side (positive(), min(2), etc. — carried over verbatim during
  // generation) are still enforced here.
  describe('generated-schema structural constraints', () => {
    function writeTempYaml(content: string): string {
      const tmpPath = path.join(os.tmpdir(), `test-strategy-${String(Date.now())}-${String(Math.random())}.yaml`)
      fs.writeFileSync(tmpPath, content)
      return tmpPath
    }

    it('accepts entry_offset_seconds=1', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_1\nnegative_funding_threshold_percent: -0.3\nentry_offset_seconds: 1\nexit_offset_seconds: 2\nfunding_applied_on_same_second: false\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).not.toThrow()
    })

    it('rejects entry_offset_seconds=0 (must be positive)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_1\nnegative_funding_threshold_percent: -0.3\nentry_offset_seconds: 0\nexit_offset_seconds: 2\nfunding_applied_on_same_second: false\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).toThrow('entry_offset_seconds')
    })

    it('accepts ladder_count=2 (minimum ladder size)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_4_1a\nnegative_funding_threshold_percent: -0.6\nentry_offset_seconds: 5\nladder_count: 2\nladder_top_mult: 0.4\nladder_bottom_mult: 1.5\ntake_profit_pct: 0.2\ndeadline_seconds: 60\nfunding_applied_on_same_second: false\nsl_multiplier: 1.5\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).not.toThrow()
    })

    it('rejects ladder_count=1 (below minimum ladder size of 2)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_4_1a\nnegative_funding_threshold_percent: -0.6\nentry_offset_seconds: 5\nladder_count: 1\nladder_top_mult: 0.4\nladder_bottom_mult: 1.5\ntake_profit_pct: 0.2\ndeadline_seconds: 60\nfunding_applied_on_same_second: false\nsl_multiplier: 1.5\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).toThrow('ladder_count')
    })
  })

  it('loads all 5 strategy configs without error', () => {
    const strategies = ['strategy_1', 'strategy_2', 'strategy_3a', 'strategy_4_1a', 'strategy_4_2a']

    for (const name of strategies) {
      const stratPath = path.join(process.cwd(), 'config', 'strategies', `${name}.yaml`)
      expect(() => loadConfig(stratPath, BASE_CONFIG)).not.toThrow()
    }
  })
})
