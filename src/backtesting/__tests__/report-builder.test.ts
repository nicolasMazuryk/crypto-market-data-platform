import { describe, it, expect } from 'vitest'
import { buildReport } from '../reporting/report-builder.js'
import type { ResolvedConfig } from '../config/schema.js'
import type { TradeResult } from '../strategies/types.js'

function makeConfig(exitOffsetSeconds: number): ResolvedConfig {
  return {
    base: {
      exchange: 'binanceusdm',
      start_date: '2025-01-01T00:00:00Z',
      end_date: '2025-01-31T00:00:00Z',
      fees: {},
      validation: {
        required_seconds_before: 5,
        required_seconds_after: 5,
        max_gap_seconds: 5,
        max_price_change_pct: 0.2,
      },
      window: { pre_funding_seconds: 60, post_funding_seconds: 60 },
      reporting: { include_trade_log: false, output_dir: 'reports' },
      funding_settlement: { tp_post_settlement_buffer_seconds: 1 },
      market_slippage_pct: 0,
      order_latency_ms: 0,
      ws_event_miss_rate: 0,
      ws_exit_extra_delay_seconds: 0,
      drop_search_window_seconds: 10,
      drop_qualifier_funding_mult: 0.5,
      drop_qualifier_range_mult: 3.0,
    },
    strategy: {
      strategy_id: 'strategy_1',
      direction: 'long',
      negative_funding_threshold_percent: -0.4,
      entry_offset_seconds: 5,
      exit_offset_seconds: exitOffsetSeconds,
      amount_usd: 20,
      leverage: 4,
    },
  }
}

function makeTrade(netPnl: number, tDropOffsetS: number | null): TradeResult {
  return {
    strategy_id: 'strategy_1',
    exchange: 'binanceusdm',
    symbol: 'BTCUSDT',
    funding_time: new Date('2025-06-01T00:00:00Z'),
    funding_rate: -0.005,
    entry_price: 50000,
    exit_price: 50000 * (1 + netPnl),
    pnl: { delta_pnl: netPnl, spread_pnl: 0, funding_pnl: 0, fees: 0, net_pnl: netPnl },
    exit_reason: 'timed',
    hold_duration: 10,
    fill_count: 1,
    funding_received: true,
    t_drop_offset_s: tDropOffsetS,
  }
}

describe('buildReport — drop offset bucketing', () => {
  it('splits net_pnl by t_drop_offset_s vs exit_offset_seconds for strategy_1', () => {
    const config = makeConfig(6)
    const trades: TradeResult[] = [
      makeTrade(0.01, 8), // exit(T+6) before drop(T+8) → exit_before_drop
      makeTrade(0.02, 10), // exit before drop → exit_before_drop
      makeTrade(-0.01, 2), // exit after/inside drop(T+2) → exit_after_or_inside_drop
      makeTrade(-0.02, 6), // t_drop_offset_s === exit_offset_seconds → exit_after_or_inside_drop
      makeTrade(0.03, null), // no drop localized → no_drop_localized
    ]

    const report = buildReport({
      config,
      trades,
      totalEventsScanned: trades.length,
      skipReasons: [],
      triggeredCount: trades.length,
      unfilledCount: 0,
      dataRowCount: 0,
      gitCommit: null,
    })

    expect(report.drop_offset_bucketing).toBeDefined()
    const bucketing = report.drop_offset_bucketing!

    expect(bucketing.exit_before_drop.count).toBe(2)
    expect(bucketing.exit_before_drop.total_net_pnl).toBeCloseTo(0.03, 10)
    expect(bucketing.exit_before_drop.mean_net_pnl).toBeCloseTo(0.015, 10)

    expect(bucketing.exit_after_or_inside_drop.count).toBe(2)
    expect(bucketing.exit_after_or_inside_drop.total_net_pnl).toBeCloseTo(-0.03, 10)

    expect(bucketing.no_drop_localized.count).toBe(1)
    expect(bucketing.no_drop_localized.total_net_pnl).toBeCloseTo(0.03, 10)
  })

  it('omits drop_offset_bucketing for non-strategy_1 strategies', () => {
    const config: ResolvedConfig = {
      ...makeConfig(6),
      strategy: {
        strategy_id: 'strategy_2',
        direction: 'long',
        negative_funding_threshold_percent: -0.4,
        entry_offset_seconds: 5,
        retracement_pct: 0.5,
        deadline_seconds: 60,
        sl_multiplier: 1,
        amount_usd: 20,
        leverage: 4,
      },
    }

    const report = buildReport({
      config,
      trades: [],
      totalEventsScanned: 0,
      skipReasons: [],
      triggeredCount: 0,
      unfilledCount: 0,
      dataRowCount: 0,
      gitCommit: null,
    })

    expect(report.drop_offset_bucketing).toBeUndefined()
  })
})
