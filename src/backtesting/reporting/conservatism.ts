import type { ResolvedConfig } from '../config/schema.js'
import type { TradeResult } from '../strategies/types.js'
import type { ErrorLogEntry, ConservatismItem, ConservatismReport } from './types.js'

/**
 * §14 conservatism report: lists the backtest's active bias-toward-pessimism simplifications.
 * `estimated_bias_pct` is only populated where the applied magnitude is directly a config knob
 * (latency/slippage/miss-rate); the structural conservatisms (fill policy, T_drop fallback,
 * conflict resolution) have no isolated P&L delta without a counterfactual re-run, so they are
 * reported `active: true` with `estimated_bias_pct: null`.
 */
export function buildConservatismReport(
  config: ResolvedConfig,
  trades: TradeResult[],
  errorEvents: ErrorLogEntry[]
): ConservatismReport {
  void trades
  void errorEvents
  const { base } = config

  const items: ConservatismItem[] = [
    {
      key: 'trade_through_only_limit_fills',
      description: 'Limit orders fill only when price trades through the limit; no better-price maker fills assumed.',
      active: true,
      estimated_bias_pct: null,
      note: 'Structural — understates TP hit rate; not isolable without a counterfactual re-run.',
    },
    {
      key: 'order_latency',
      description: `Simulated order placement latency of ${String(base.order_latency_ms)}ms injected on every action.`,
      active: base.order_latency_ms > 0,
      estimated_bias_pct: null,
      note: 'Worsens every entry/exit price; magnitude depends on realized volatility per fill.',
    },
    {
      key: 't_drop_fallback_latest_edge',
      description: 'T_drop fallback uses the latest search-window edge when no drop candle localizes.',
      active: true,
      estimated_bias_pct: null,
      note: 'Latest possible arming — structural, not isolable without a counterfactual re-run.',
    },
    {
      key: 'worst_ordering_conflict_resolution',
      description: 'SL-first / worst-ordering used to resolve ambiguous same-candle SL/TP conflicts.',
      active: true,
      estimated_bias_pct: null,
      note: 'Always resolves to the worst fill of any ambiguous candle — structural.',
    },
    {
      key: 'ws_event_miss_rate',
      description: `WS funding-fee event miss rate of ${String(base.ws_event_miss_rate)} forces occasional fallback-timeout exits.`,
      active: base.ws_event_miss_rate > 0,
      estimated_bias_pct: null,
      note: 'Occasional worst-path exits live rarely takes.',
    },
    {
      key: 'market_slippage',
      description: `Slippage of ${String(base.market_slippage_pct)}% applied to every market/stop fill.`,
      active: base.market_slippage_pct > 0,
      estimated_bias_pct: null,
      note: 'Direct cost baked into fill prices; not separable from PnlBreakdown without a counterfactual re-run.',
    },
    {
      key: 'funding_pnl_zero_for_ladder_strategies',
      description: 'FUNDING_PNL booked as 0 unconditionally for 4.* strategies, including pre-settlement fills.',
      active: config.strategy.strategy_id === 'strategy_4_1a' || config.strategy.strategy_id === 'strategy_4_2a',
      estimated_bias_pct: null,
      note: 'Discards a possible funding windfall.',
    },
    {
      key: 'settled_rate_selection_proxy',
      description: 'Trade selection uses the settled funding rate as a proxy (the one named optimism, §5.2).',
      active: true,
      estimated_bias_pct: null,
      note: 'Bounded by threshold-sensitivity sweeps, not correctable from available data.',
    },
  ]

  return items
}
