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
      expect(config.strategy.funding_threshold).toBe(0.004)
      expect(config.strategy.entry_offset_seconds).toBe(2)
      expect(config.strategy.exit_offset_seconds).toBe(2)
    }
  })

  it('loads strategy_3a config with TP mode A', () => {
    const stratPath = path.join(process.cwd(), 'config', 'strategies', 'strategy_3a.yaml')
    const config = loadConfig(stratPath, BASE_CONFIG)

    expect(config.strategy.strategy_id).toBe('strategy_3a')
    if (config.strategy.strategy_id === 'strategy_3a') {
      expect(config.strategy.tp_mode).toBe('A')
      expect(config.strategy.tp_multiplier).toBe(1.5)
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

  it('loads strategy_4_1b config with funding_applied_on_same_second=true', () => {
    const stratPath = path.join(process.cwd(), 'config', 'strategies', 'strategy_4_1b.yaml')
    const config = loadConfig(stratPath, BASE_CONFIG)

    if (config.strategy.strategy_id === 'strategy_4_1b') {
      expect(config.strategy.funding_applied_on_same_second).toBe(true)
    }
  })

  it('loads strategy_5 config', () => {
    const stratPath = path.join(process.cwd(), 'config', 'strategies', 'strategy_5.yaml')
    const config = loadConfig(stratPath, BASE_CONFIG)

    if (config.strategy.strategy_id === 'strategy_5') {
      expect(config.strategy.exchange_a).toBe('binance')
      expect(config.strategy.exchange_b).toBe('bybit')
      expect(config.strategy.funding_threshold_a).toBe(0.005)
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

  it('defaults funding_time_tolerance_seconds to 60 when absent', () => {
    const stratPath = path.join(process.cwd(), 'config', 'strategies', 'strategy_5.yaml')
    const config = loadConfig(stratPath, BASE_CONFIG)
    expect(config.base.funding_time_tolerance_seconds).toBe(60)
  })

  it('throws for non-existent base config', () => {
    const stratPath = path.join(process.cwd(), 'config', 'strategies', 'strategy_1.yaml')
    expect(() => loadConfig(stratPath, '/nonexistent/path.yaml')).toThrow('Base config not found')
  })

  it('throws for non-existent strategy config', () => {
    expect(() => loadConfig('/nonexistent/strategy.yaml', BASE_CONFIG)).toThrow('Strategy config not found')
  })

  describe('hard parameter bounds', () => {
    function writeTempYaml(content: string): string {
      const tmpPath = path.join(os.tmpdir(), `test-strategy-${String(Date.now())}-${String(Math.random())}.yaml`)
      fs.writeFileSync(tmpPath, content)
      return tmpPath
    }

    it('accepts entry_offset_seconds=2 (valid lower edge)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_1\nfunding_threshold: 0.003\nentry_offset_seconds: 2\nexit_offset_seconds: 2\nfunding_applied_on_same_second: false\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).not.toThrow()
    })

    it('rejects entry_offset_seconds=1 (below minimum 2)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_1\nfunding_threshold: 0.003\nentry_offset_seconds: 1\nexit_offset_seconds: 2\nfunding_applied_on_same_second: false\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).toThrow('entry_offset_seconds')
    })

    it('rejects exit_offset_seconds=1 (below minimum 2)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_1\nfunding_threshold: 0.003\nentry_offset_seconds: 5\nexit_offset_seconds: 1\nfunding_applied_on_same_second: false\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).toThrow('exit_offset_seconds')
    })

    it('accepts deadline_seconds=180 (valid)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_2\nfunding_threshold: 0.003\nentry_offset_seconds: 5\nretracement_pct: 0.5\ndeadline_seconds: 180\nsl_mult: 1.5\nfunding_applied_on_same_second: false\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).not.toThrow()
    })

    it('accepts deadline_seconds=2 (valid lower edge)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_2\nfunding_threshold: 0.003\nentry_offset_seconds: 5\nretracement_pct: 0.5\ndeadline_seconds: 2\nsl_mult: 1.5\nfunding_applied_on_same_second: false\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).not.toThrow()
    })

    it('accepts deadline_seconds=181 (no upper cap)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_2\nfunding_threshold: 0.003\nentry_offset_seconds: 5\nretracement_pct: 0.5\ndeadline_seconds: 181\nsl_mult: 1.5\nfunding_applied_on_same_second: false\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).not.toThrow()
    })

    it('rejects deadline_seconds=1 (below minimum 2)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_2\nfunding_threshold: 0.003\nentry_offset_seconds: 5\nretracement_pct: 0.5\ndeadline_seconds: 1\nsl_mult: 1.5\nfunding_applied_on_same_second: false\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).toThrow('deadline_seconds')
    })

    it('accepts deadline_seconds=2 for strategy_3a (valid lower edge)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_3a\nfunding_threshold: 0.004\nentry_offset_seconds: 5\nstop_loss: 0.01\ntp_mode: A\ntp_multiplier: 1.5\ntp_addend: 0.004\ndeadline_seconds: 2\nfunding_applied_on_same_second: true\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).not.toThrow()
    })

    it('rejects deadline_seconds=1 for strategy_3a (below minimum 2)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_3a\nfunding_threshold: 0.004\nentry_offset_seconds: 5\nstop_loss: 0.01\ntp_mode: A\ntp_multiplier: 1.5\ntp_addend: 0.004\ndeadline_seconds: 1\nfunding_applied_on_same_second: true\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).toThrow('deadline_seconds')
    })

    it('accepts deadline_seconds=60 for strategy_3b', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_3b\nfunding_threshold: 0.004\nentry_offset_seconds: 5\nstop_loss: 0.01\ntp_mode: B\ntp_multiplier: 1.5\ntp_addend: 0.004\ndeadline_seconds: 60\nfunding_applied_on_same_second: true\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).not.toThrow()
    })

    it('rejects deadline_seconds=1 for strategy_3b (below minimum 2)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_3b\nfunding_threshold: 0.004\nentry_offset_seconds: 5\nstop_loss: 0.01\ntp_mode: B\ntp_multiplier: 1.5\ntp_addend: 0.004\ndeadline_seconds: 1\nfunding_applied_on_same_second: true\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).toThrow('deadline_seconds')
    })

    it('accepts ladder_count=2 (valid lower edge)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_4_1a\nfunding_threshold: 0.006\nentry_offset_seconds: 5\nladder_count: 2\nladder_top_mult: 0.4\nladder_bottom_mult: 1.5\ntake_profit: 0.002\ndeadline_seconds: 60\nfunding_applied_on_same_second: false\nsl_mult: 1.5\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).not.toThrow()
    })

    it('rejects ladder_count=1 (below minimum 2)', () => {
      const tmpPath = writeTempYaml(
        'strategy_id: strategy_4_1a\nfunding_threshold: 0.006\nentry_offset_seconds: 5\nladder_count: 1\nladder_top_mult: 0.4\nladder_bottom_mult: 1.5\ntake_profit: 0.002\ndeadline_seconds: 60\nfunding_applied_on_same_second: false\nsl_mult: 1.5\n'
      )
      expect(() => loadConfig(tmpPath, BASE_CONFIG)).toThrow('ladder_count')
    })
  })

  it('loads all 11 strategy configs without error', () => {
    const strategies = [
      'strategy_1',
      'strategy_2',
      'strategy_3a',
      'strategy_3b',
      'strategy_4_1a',
      'strategy_4_1b',
      'strategy_4_2a',
      'strategy_4_2b',
      'strategy_4_3a',
      'strategy_4_3b',
      'strategy_5',
    ]

    for (const name of strategies) {
      const stratPath = path.join(process.cwd(), 'config', 'strategies', `${name}.yaml`)
      expect(() => loadConfig(stratPath, BASE_CONFIG)).not.toThrow()
    }
  })
})
