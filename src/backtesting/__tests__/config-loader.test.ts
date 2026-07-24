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
      expect(config.strategy.exit_offset_seconds).toBe(10)
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

  it('loads strategy_4_1a config with ladder_count=5', () => {
    const stratPath = path.join(process.cwd(), 'config', 'strategies', 'strategy_4_1a.yaml')
    const config = loadConfig(stratPath, BASE_CONFIG)

    if (config.strategy.strategy_id === 'strategy_4_1a') {
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

  // §11.1 hard bounds, sourced from CANONICAL_PARAMS `bounds` and enforced by the
  // generated backtest schema (Task 06). Per-bound coverage lives in bounds.test.ts —
  // this block keeps the pre-existing structural-constraint regression cases.
  describe('generated-schema structural constraints', () => {
    function writeTempYaml(content: string): string {
      const tmpPath = path.join(os.tmpdir(), `test-strategy-${String(Date.now())}-${String(Math.random())}.yaml`)
      fs.writeFileSync(tmpPath, content)
      return tmpPath
    }

    it('rejects entry_offset_seconds=2 (below the new >=3 bound)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_1\nnegative_funding_threshold_percent: -0.3\nentry_offset_seconds: 2\nexit_offset_seconds: 10\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).toThrow('entry_offset_seconds')
    })

    it('accepts entry_offset_seconds=3 (minimum)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_1\nnegative_funding_threshold_percent: -0.3\nentry_offset_seconds: 3\nexit_offset_seconds: 10\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).not.toThrow()
    })

    it('rejects entry_offset_seconds=0 (must be positive)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_1\nnegative_funding_threshold_percent: -0.3\nentry_offset_seconds: 0\nexit_offset_seconds: 10\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).toThrow('entry_offset_seconds')
    })

    it('accepts ladder_count=2 (minimum ladder size)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_4_1a\nnegative_funding_threshold_percent: -0.6\nentry_offset_seconds: 5\nladder_count: 2\nladder_top_mult: 0.4\nladder_bottom_mult: 1.5\ntake_profit_pct: 0.2\ndeadline_seconds: 60\nsl_multiplier: 1.5\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).not.toThrow()
    })

    it('rejects ladder_count=1 (below minimum ladder size of 2)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_4_1a\nnegative_funding_threshold_percent: -0.6\nentry_offset_seconds: 5\nladder_count: 1\nladder_top_mult: 0.4\nladder_bottom_mult: 1.5\ntake_profit_pct: 0.2\ndeadline_seconds: 60\nsl_multiplier: 1.5\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).toThrow('ladder_count')
    })

    it('accepts ladder_count=20 (maximum ladder size)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_4_1a\nnegative_funding_threshold_percent: -0.6\nentry_offset_seconds: 5\nladder_count: 20\nladder_top_mult: 0.4\nladder_bottom_mult: 1.5\ntake_profit_pct: 0.2\ndeadline_seconds: 60\nsl_multiplier: 1.5\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).not.toThrow()
    })

    it('rejects ladder_count=21 (above maximum ladder size of 20)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_4_1a\nnegative_funding_threshold_percent: -0.6\nentry_offset_seconds: 5\nladder_count: 21\nladder_top_mult: 0.4\nladder_bottom_mult: 1.5\ntake_profit_pct: 0.2\ndeadline_seconds: 60\nsl_multiplier: 1.5\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).toThrow('ladder_count')
    })

    it('accepts deadline_seconds=1800 (real live value)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_4_1a\nnegative_funding_threshold_percent: -0.6\nentry_offset_seconds: 5\nladder_count: 2\nladder_top_mult: 0.4\nladder_bottom_mult: 1.5\ntake_profit_pct: 0.2\ndeadline_seconds: 1800\nsl_multiplier: 1.5\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).not.toThrow()
    })

    it('rejects deadline_seconds=5 (below the new >=10 bound)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_4_1a\nnegative_funding_threshold_percent: -0.6\nentry_offset_seconds: 5\nladder_count: 2\nladder_top_mult: 0.4\nladder_bottom_mult: 1.5\ntake_profit_pct: 0.2\ndeadline_seconds: 5\nsl_multiplier: 1.5\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).toThrow('deadline_seconds')
    })

    it('rejects take_profit_pct=0.003 (unit-suspect fraction) end-to-end through the loader', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_4_1a\nnegative_funding_threshold_percent: -0.6\nentry_offset_seconds: 5\nladder_count: 2\nladder_top_mult: 0.4\nladder_bottom_mult: 1.5\ntake_profit_pct: 0.003\ndeadline_seconds: 60\nsl_multiplier: 1.5\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).toThrow('unit_suspect_fraction')
    })

    it("rejects an unrecognized/typo'd key end-to-end through the loader", () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_1\nnegative_funding_threshold_percent: -0.3\nentry_offset_seconds: 5\nexit_offset_seconds: 10\ntake_profit_percent: 0.3\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).toThrow()
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
