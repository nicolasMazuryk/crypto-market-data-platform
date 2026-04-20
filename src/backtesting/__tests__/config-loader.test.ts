import { describe, it, expect } from 'vitest'
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
    expect(config.base.validation.required_seconds_before).toBe(5)

    expect(config.strategy.strategy_id).toBe('strategy_1')
    if (config.strategy.strategy_id === 'strategy_1') {
      expect(config.strategy.funding_threshold).toBe(0.004)
      expect(config.strategy.entry_offset_seconds).toBe(5)
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

  it('loads strategy_4_1a config with include_funding=false', () => {
    const stratPath = path.join(process.cwd(), 'config', 'strategies', 'strategy_4_1a.yaml')
    const config = loadConfig(stratPath, BASE_CONFIG)

    if (config.strategy.strategy_id === 'strategy_4_1a') {
      expect(config.strategy.include_funding).toBe(false)
      expect(config.strategy.ladder_count).toBe(5)
    }
  })

  it('loads strategy_4_1b config with include_funding=true', () => {
    const stratPath = path.join(process.cwd(), 'config', 'strategies', 'strategy_4_1b.yaml')
    const config = loadConfig(stratPath, BASE_CONFIG)

    if (config.strategy.strategy_id === 'strategy_4_1b') {
      expect(config.strategy.include_funding).toBe(true)
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
