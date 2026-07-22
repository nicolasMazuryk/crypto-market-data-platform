# Strategy 6 — Live-Empirical Validation Protocol

Strategy 6 (post-funding directional, WS-gated MAIN entry) cannot be backtested: MAIN is causally
gated on a private `ws.funding_fee` event and its fill sits inside the forbidden `drop_candle`
(`docs-strategy/strategies/00_globals.md` §5.5.2). Validation is therefore live-empirical —
shadow phase, then canary phase — per `docs-strategy/strategies/07_strategy_6.md` §6.2.

## Shadow phase (≥ 2 weeks, all venues)

Run the full state machine with entry-order submission (PRE_FUNDING, MAIN) stubbed at the
order-adapter choke point — log-only synthetic ACK + fill, no real entry order ever reaches the
exchange. Enable with `testing.strategy6ShadowMode: true`. SL/TP exit legs still place via the
real REST adapter (reduce-only, unaffected by this flag) since §6.2 only concerns the
causally-gated entry path.

Measures:

- Event arrival rate and `T_event − T_settle` latency distribution per venue.
- Would-be MAIN decision timestamps.
- Selection frequency at the configured `fundingThresholdPercent`.

The per-trade `strategy6.event_timeline` log (emitted on MAIN fill, and on
`funding_event_timeout` / `close_pre_funding_failed` for the partial-fill case) is the
calibration dataset: `tSettle`, `eventReceiveAt`, `eventLatencyMs`, `mainSendAt`, `mainFillAt`,
`settledFundingRatePercent`.

## Canary phase (≥ 4 weeks)

Live, with minimum sizing (`mainAmountUsd` at min feasible, one symbol cohort per venue).

### Pre-registered acceptance thresholds (§6.2.2)

| # | Metric | Threshold |
|---|--------|-----------|
| (a) | `funding_event_timeout` rate | ≤ 2× the shadow-phase miss estimate |
| (b) | MAIN slippage distribution vs `market_slippage_pct` | p90 ≤ 2× assumed |
| (c) | Realized PRE overhead (`\|PRE_FUNDING_DELTA\| + \|FUNDING_PRE\| + PRE fees`) in bp of net notional | informational — no hard gate, reported for canary review |
| (d) | Funding-attribution audit per venue against income statements | must reconcile |
| (e) | `close_pre_funding_failed` occurrences | zero, else **halt** |

Thresholds and the gate evaluator live in `src/execution/strategies/strategy-6-canary.ts`
(`STRATEGY_6_CANARY_THRESHOLDS`, `evaluateStrategy6CanaryGate`) rather than per-deploy config, so
the gate is code-reviewable and cannot be loosened silently.

### Halt rule

(e) is an immediate halt regardless of the other metrics. The `close_pre_funding_failed` path
(`manager.ts`, pre_funding_then_main entry branch) emits both the existing `ops.event`
(`close_pre_funding_failed`, level `error`) and a `strategy6.canary_halt` ops signal
(level `fatal`) the moment it fires — do not wait for the next canary-gate evaluation cycle to
stop trading.
