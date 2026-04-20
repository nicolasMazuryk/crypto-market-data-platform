import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BacktestReport } from '../../backtesting/reporting/types.js'
import { extractMetrics, parseReport } from '../backtest/parser.js'

function makeReport(overrides: Partial<BacktestReport> = {}): BacktestReport {
  return {
    strategy_id: 'strategy_1',
    trade_stats: {
      total_funding_events: 100,
      events_skipped: 10,
      skip_reasons: {},
      events_triggered: 90,
      trades_executed: 80,
      unfilled_events: 0,
    },
    return_metrics: {
      total_net_pnl: 0.123,
      mean_net_pnl: 0.001,
      median_net_pnl: 0.0005,
      std_dev: 0.02,
      skewness: 0,
      kurtosis: 0,
      best_trade: 0.05,
      worst_trade: -0.03,
    },
    win_loss: {
      win_rate: 0.55,
      avg_win: 0.002,
      avg_loss: -0.001,
      profit_factor: 2,
      expectancy: 0.0007,
    },
    pnl_decomposition: {
      aggregate_delta_pnl: 0.1,
      aggregate_funding_pnl: 0.05,
      aggregate_fees: -0.027,
      funding_ratio: 0.4,
    },
    risk_metrics: {
      max_drawdown_pct: 0.05,
      max_drawdown_duration_seconds: 60,
      sharpe_ratio: 1.75,
      sortino_ratio: 2,
      calmar_ratio: 1,
    },
    exit_reason_distribution: {
      TP_HIT: { count: 40, pct: 0.5 },
      SL_HIT: { count: 20, pct: 0.25 },
      DEADLINE: { count: 15, pct: 0.18 },
      MARKET_EXIT: { count: 5, pct: 0.07 },
      UNFILLED: { count: 0, pct: 0 },
    },
    data_quality: {
      total_events_scanned: 100,
      events_skipped_by_reason: {},
      data_coverage_pct: 1,
      actual_date_range: { start: '2025-01-01', end: '2025-01-02' },
      configured_date_range: { start: '2025-01-01', end: '2025-01-02' },
    },
    reproducibility: {
      config_hash: 'abc',
      data_row_count: 123,
      run_timestamp: '2026-04-18T00:00:00Z',
      git_commit: null,
    },
    equity_curve: [],
    ...overrides,
  }
}

describe('backtest parser', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-parser-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('parseReport + extractMetrics pulls the right fields', () => {
    const report = makeReport()
    const file = path.join(dir, 'report.json')
    fs.writeFileSync(file, JSON.stringify(report))
    const parsed = parseReport(file)
    const metrics = extractMetrics(parsed)
    expect(metrics.total_net_pnl).toBeCloseTo(0.123)
    expect(metrics.sharpe).toBeCloseTo(1.75)
    expect(metrics.win_rate).toBeCloseTo(0.55)
    expect(metrics.trades).toBe(80)
  })

  it('maps non-finite sharpe/win_rate to 0 without throwing', () => {
    const report = makeReport({
      win_loss: {
        win_rate: Number.NaN,
        avg_win: 0,
        avg_loss: 0,
        profit_factor: Number.POSITIVE_INFINITY,
        expectancy: 0,
      },
      risk_metrics: {
        max_drawdown_pct: 0,
        max_drawdown_duration_seconds: 0,
        sharpe_ratio: Number.POSITIVE_INFINITY,
        sortino_ratio: Number.POSITIVE_INFINITY,
        calmar_ratio: 0,
      },
    })
    const metrics = extractMetrics(report)
    expect(metrics.sharpe).toBe(0)
    expect(metrics.win_rate).toBe(0)
  })
})
