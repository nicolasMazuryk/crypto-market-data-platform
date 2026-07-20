import { describe, it, expect } from 'vitest'

import { GeneratedBacktestStrategySchema } from './generate-backtest.js'
import { GeneratedLiveStrategySchema } from './generate-live.js'

// Valid baseline configs, one per strategy/side, used as the starting point for each
// bound test — only the field under test is overridden.

function bt1(overrides: Record<string, unknown> = {}) {
  return {
    strategy_id: 'strategy_1',
    direction: 'long',
    negative_funding_threshold_percent: -0.4,
    entry_offset_seconds: 5,
    exit_offset_seconds: 6,
    funding_applied_on_same_second: false,
    amount_usd: 20,
    leverage: 4,
    ...overrides,
  }
}

function live1(overrides: Record<string, unknown> = {}) {
  return {
    id: 'strategy_1',
    enabled: true,
    negativeFundingThresholdPercent: -0.4,
    entryOffsetSeconds: 5,
    exitOffsetSeconds: 6,
    amountUsd: 20,
    leverage: 4,
    ...overrides,
  }
}

function live1ws(overrides: Record<string, unknown> = {}) {
  return {
    id: 'strategy_1_ws',
    enabled: true,
    negativeFundingThresholdPercent: -0.4,
    entryOffsetSeconds: 5,
    fundingFeeTimeoutSeconds: 30,
    amountUsd: 20,
    leverage: 4,
    ...overrides,
  }
}

function bt2(overrides: Record<string, unknown> = {}) {
  return {
    strategy_id: 'strategy_2',
    direction: 'long',
    negative_funding_threshold_percent: -0.4,
    entry_offset_seconds: 5,
    retracement_pct: 0.5,
    deadline_seconds: 60,
    sl_multiplier: 1.0,
    funding_applied_on_same_second: false,
    amount_usd: 20,
    leverage: 4,
    ...overrides,
  }
}

function live2(overrides: Record<string, unknown> = {}) {
  return {
    id: 'strategy_2',
    enabled: true,
    negativeFundingThresholdPercent: -0.4,
    entryOffsetSeconds: 5,
    retracementPct: 0.5,
    deadlineSeconds: 60,
    slMultiplier: 1.0,
    fundingFeeTimeoutSeconds: 30,
    amountUsd: 20,
    leverage: 4,
    ...overrides,
  }
}

function bt3a(overrides: Record<string, unknown> = {}) {
  return {
    strategy_id: 'strategy_3a',
    direction: 'short',
    negative_funding_threshold_percent: -0.4,
    entry_offset_seconds: 5,
    stop_loss_percent: 1.0,
    tp_mode: 'A',
    tp_multiplier: 1.5,
    tp_addend_pct: 0.4,
    deadline_seconds: 60,
    funding_applied_on_same_second: true,
    amount_usd: 20,
    leverage: 4,
    ...overrides,
  }
}

function live3a(overrides: Record<string, unknown> = {}) {
  return {
    id: 'strategy_3a',
    enabled: true,
    negativeFundingThresholdPercent: -0.4,
    entryOffsetSeconds: 5,
    stopLossPercent: 1.0,
    tpVariantAMultiplier: 1.5,
    tpVariantBOffsetPercent: 0.4,
    deadlineSeconds: 60,
    amountUsd: 20,
    leverage: 4,
    ...overrides,
  }
}

function bt41a(overrides: Record<string, unknown> = {}) {
  return {
    strategy_id: 'strategy_4_1a',
    direction: 'long',
    negative_funding_threshold_percent: -0.4,
    entry_offset_seconds: 5,
    ladder_count: 5,
    ladder_top_mult: 0.4,
    ladder_bottom_mult: 1.5,
    take_profit_pct: 0.2,
    deadline_seconds: 60,
    funding_applied_on_same_second: false,
    sl_multiplier: 1.5,
    amount_usd: 20,
    leverage: 4,
    ...overrides,
  }
}

function live41a(overrides: Record<string, unknown> = {}) {
  return {
    id: 'strategy_4_1a',
    enabled: true,
    negativeFundingThresholdPercent: -0.4,
    entryOffsetSeconds: 5,
    ladderCount: 5,
    ladderTopMult: 0.4,
    ladderBottomMult: 1.5,
    takeProfitPct: 0.2,
    deadlineSeconds: 60,
    slMultiplier: 1.5,
    amountUsd: 20,
    leverage: 4,
    ...overrides,
  }
}

function bt42a(overrides: Record<string, unknown> = {}) {
  return {
    strategy_id: 'strategy_4_2a',
    direction: 'long',
    negative_funding_threshold_percent: -0.4,
    entry_offset_seconds: 5,
    limit_offset_mult: 0.75,
    take_profit_pct: 0.2,
    deadline_seconds: 60,
    funding_applied_on_same_second: false,
    sl_multiplier: 1.5,
    amount_usd: 20,
    leverage: 4,
    ...overrides,
  }
}

function live42a(overrides: Record<string, unknown> = {}) {
  return {
    id: 'strategy_4_2a',
    enabled: true,
    negativeFundingThresholdPercent: -0.4,
    entryOffsetSeconds: 5,
    limitOffsetMult: 0.75,
    takeProfitPct: 0.2,
    deadlineSeconds: 60,
    slMultiplier: 1.5,
    amountUsd: 20,
    leverage: 4,
    ...overrides,
  }
}

function rejects(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false)
}

function accepts(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(true)
}

describe('§11.1 hard parameter bounds', () => {
  describe('entry_offset_seconds: min 2', () => {
    it('rejects below min (1) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt1({ entry_offset_seconds: 1 }))
      rejects(GeneratedLiveStrategySchema, live1({ entryOffsetSeconds: 1 }))
    })
    it('accepts the min (2) on both loaders', () => {
      accepts(GeneratedBacktestStrategySchema, bt1({ entry_offset_seconds: 2 }))
      accepts(GeneratedLiveStrategySchema, live1({ entryOffsetSeconds: 2 }))
    })
  })

  describe('exit_offset_seconds: min 6', () => {
    it('rejects below min (5) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt1({ exit_offset_seconds: 5 }))
      rejects(GeneratedLiveStrategySchema, live1({ exitOffsetSeconds: 5 }))
    })
    it('accepts the min (6) on both loaders', () => {
      accepts(GeneratedBacktestStrategySchema, bt1({ exit_offset_seconds: 6 }))
      accepts(GeneratedLiveStrategySchema, live1({ exitOffsetSeconds: 6 }))
    })
  })

  describe('retracement_pct: 0 < v <= 1', () => {
    it('rejects 0 (exclusive min) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt2({ retracement_pct: 0 }))
      rejects(GeneratedLiveStrategySchema, live2({ retracementPct: 0 }))
    })
    it('rejects above max (1.1) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt2({ retracement_pct: 1.1 }))
      rejects(GeneratedLiveStrategySchema, live2({ retracementPct: 1.1 }))
    })
    it('accepts the max (1.0) on both loaders', () => {
      accepts(GeneratedBacktestStrategySchema, bt2({ retracement_pct: 1.0 }))
      accepts(GeneratedLiveStrategySchema, live2({ retracementPct: 1.0 }))
    })
  })

  describe('deadline_seconds: 10..3600 (R3)', () => {
    it('rejects below min (5) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt2({ deadline_seconds: 5 }))
      rejects(GeneratedLiveStrategySchema, live2({ deadlineSeconds: 5 }))
    })
    it('rejects above max (3601) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt2({ deadline_seconds: 3601 }))
      rejects(GeneratedLiveStrategySchema, live2({ deadlineSeconds: 3601 }))
    })
    it('accepts the real live value (1800) on both loaders', () => {
      accepts(GeneratedBacktestStrategySchema, bt2({ deadline_seconds: 1800 }))
      accepts(GeneratedLiveStrategySchema, live2({ deadlineSeconds: 1800 }))
    })
  })

  describe('sl_multiplier: 0.5..4.0 (base)', () => {
    it('rejects below min (0.4) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt2({ sl_multiplier: 0.4 }))
      rejects(GeneratedLiveStrategySchema, live2({ slMultiplier: 0.4 }))
    })
    it('rejects above max (4.1) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt2({ sl_multiplier: 4.1 }))
      rejects(GeneratedLiveStrategySchema, live2({ slMultiplier: 4.1 }))
    })
    it('accepts the min (0.5) on both loaders', () => {
      accepts(GeneratedBacktestStrategySchema, bt2({ sl_multiplier: 0.5 }))
      accepts(GeneratedLiveStrategySchema, live2({ slMultiplier: 0.5 }))
    })
  })

  describe('stop_loss_percent: 0.2..5.0', () => {
    it('rejects below min (0.1) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt3a({ stop_loss_percent: 0.1 }))
      rejects(GeneratedLiveStrategySchema, live3a({ stopLossPercent: 0.1 }))
    })
    it('rejects above max (5.1) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt3a({ stop_loss_percent: 5.1 }))
      rejects(GeneratedLiveStrategySchema, live3a({ stopLossPercent: 5.1 }))
    })
    it('accepts the min (0.2) on both loaders', () => {
      accepts(GeneratedBacktestStrategySchema, bt3a({ stop_loss_percent: 0.2 }))
      accepts(GeneratedLiveStrategySchema, live3a({ stopLossPercent: 0.2 }))
    })
  })

  describe('take_profit_pct: 0.05..5.0', () => {
    it('rejects below min (0.04) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt41a({ take_profit_pct: 0.04 }))
      rejects(GeneratedLiveStrategySchema, live41a({ takeProfitPct: 0.04 }))
    })
    it('rejects above max (5.1) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt41a({ take_profit_pct: 5.1 }))
      rejects(GeneratedLiveStrategySchema, live41a({ takeProfitPct: 5.1 }))
    })
    it('accepts the min (0.05) on both loaders', () => {
      accepts(GeneratedBacktestStrategySchema, bt41a({ take_profit_pct: 0.05 }))
      accepts(GeneratedLiveStrategySchema, live41a({ takeProfitPct: 0.05 }))
    })
  })

  describe('ladder_count: 2..20', () => {
    it('rejects below min (1) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt41a({ ladder_count: 1 }))
      rejects(GeneratedLiveStrategySchema, live41a({ ladderCount: 1 }))
    })
    it('rejects above max (21) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt41a({ ladder_count: 21 }))
      rejects(GeneratedLiveStrategySchema, live41a({ ladderCount: 21 }))
    })
    it('accepts the min (2) and max (20) on both loaders', () => {
      accepts(GeneratedBacktestStrategySchema, bt41a({ ladder_count: 2 }))
      accepts(GeneratedLiveStrategySchema, live41a({ ladderCount: 2 }))
      accepts(GeneratedBacktestStrategySchema, bt41a({ ladder_count: 20 }))
      accepts(GeneratedLiveStrategySchema, live41a({ ladderCount: 20 }))
    })
  })

  describe('funding_fee_timeout_seconds: 5..120 (live only — no backtest key)', () => {
    it('rejects below min (4)', () => {
      rejects(GeneratedLiveStrategySchema, live1ws({ fundingFeeTimeoutSeconds: 4 }))
    })
    it('rejects above max (121)', () => {
      rejects(GeneratedLiveStrategySchema, live1ws({ fundingFeeTimeoutSeconds: 121 }))
    })
    it('accepts the min (5)', () => {
      accepts(GeneratedLiveStrategySchema, live1ws({ fundingFeeTimeoutSeconds: 5 }))
    })
  })

  describe('negative_funding_threshold_percent: -5.0 <= v < 0', () => {
    it('rejects below min (-5.1) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt1({ negative_funding_threshold_percent: -5.1 }))
      rejects(GeneratedLiveStrategySchema, live1({ negativeFundingThresholdPercent: -5.1 }))
    })
    it('rejects 0 (exclusive max — signed, must stay negative) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt1({ negative_funding_threshold_percent: 0 }))
      rejects(GeneratedLiveStrategySchema, live1({ negativeFundingThresholdPercent: 0 }))
    })
    it('accepts the min (-5.0) on both loaders', () => {
      accepts(GeneratedBacktestStrategySchema, bt1({ negative_funding_threshold_percent: -5.0 }))
      accepts(GeneratedLiveStrategySchema, live1({ negativeFundingThresholdPercent: -5.0 }))
    })
  })

  describe('cross-field: ladder_bottom_mult must be > ladder_top_mult (strategy_4_1a)', () => {
    it('rejects bottom <= top on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt41a({ ladder_bottom_mult: 0.4, ladder_top_mult: 0.5 }))
      rejects(GeneratedLiveStrategySchema, live41a({ ladderBottomMult: 0.4, ladderTopMult: 0.5 }))
    })
    it('accepts bottom > top on both loaders', () => {
      accepts(GeneratedBacktestStrategySchema, bt41a({ ladder_bottom_mult: 1.5, ladder_top_mult: 0.4 }))
      accepts(GeneratedLiveStrategySchema, live41a({ ladderBottomMult: 1.5, ladderTopMult: 0.4 }))
    })
  })

  describe('cross-field: sl_multiplier must be > limit_offset_mult (strategy_4_2a)', () => {
    it('rejects sl_multiplier <= limit_offset_mult on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt42a({ sl_multiplier: 2.0, limit_offset_mult: 3.0 }))
      rejects(GeneratedLiveStrategySchema, live42a({ slMultiplier: 2.0, limitOffsetMult: 3.0 }))
    })
    it('accepts sl_multiplier > limit_offset_mult on both loaders', () => {
      accepts(GeneratedBacktestStrategySchema, bt42a({ sl_multiplier: 2.0, limit_offset_mult: 1.5 }))
      accepts(GeneratedLiveStrategySchema, live42a({ slMultiplier: 2.0, limitOffsetMult: 1.5 }))
    })
  })

  describe('§11.2 unit-mismatch protection', () => {
    it('rejects take_profit_pct=0.003 (fraction mistaken for percent) with unit_suspect_fraction on both loaders', () => {
      const btResult = GeneratedBacktestStrategySchema.safeParse(bt41a({ take_profit_pct: 0.003 }))
      const liveResult = GeneratedLiveStrategySchema.safeParse(live41a({ takeProfitPct: 0.003 }))
      expect(btResult.success).toBe(false)
      expect(liveResult.success).toBe(false)
      if (!btResult.success) expect(btResult.error.issues[0]?.message).toContain('unit_suspect_fraction')
      if (!liveResult.success) expect(liveResult.error.issues[0]?.message).toContain('unit_suspect_fraction')
    })

    it('rejects retracement_pct=1.5 (percent mistaken for fraction) on both loaders', () => {
      rejects(GeneratedBacktestStrategySchema, bt2({ retracement_pct: 1.5 }))
      rejects(GeneratedLiveStrategySchema, live2({ retracementPct: 1.5 }))
    })

    it('rejects an unrecognized key (typo) on both loaders', () => {
      rejects(GeneratedLiveStrategySchema, live1({ entryOffsetSecond: 5 }))
      rejects(GeneratedBacktestStrategySchema, bt1({ entryOffsetSecond: 5 }))
    })

    it('rejects a stray unknown key on both loaders', () => {
      rejects(GeneratedLiveStrategySchema, live1({ foo: 1 }))
      rejects(GeneratedBacktestStrategySchema, bt1({ foo: 1 }))
    })
  })

  describe('per-strategy sl_multiplier override: strategy_4_2a is 1.0..4.0, base is 0.5..4.0', () => {
    it('accepts 0.7 for strategy_2 (within the base 0.5..4.0 range)', () => {
      accepts(GeneratedBacktestStrategySchema, bt2({ sl_multiplier: 0.7 }))
      accepts(GeneratedLiveStrategySchema, live2({ slMultiplier: 0.7 }))
    })
    it('rejects 0.7 for strategy_4_2a (below its overridden 1.0 minimum)', () => {
      rejects(GeneratedBacktestStrategySchema, bt42a({ sl_multiplier: 0.7, limit_offset_mult: 0.5 }))
      rejects(GeneratedLiveStrategySchema, live42a({ slMultiplier: 0.7, limitOffsetMult: 0.5 }))
    })
    it('accepts 1.0 for strategy_4_2a (its overridden minimum)', () => {
      accepts(GeneratedBacktestStrategySchema, bt42a({ sl_multiplier: 1.0, limit_offset_mult: 0.5 }))
      accepts(GeneratedLiveStrategySchema, live42a({ slMultiplier: 1.0, limitOffsetMult: 0.5 }))
    })
  })
})
