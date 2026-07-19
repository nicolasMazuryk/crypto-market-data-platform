---
# Task 15 — Backtest outputs + conservatism report

**Phase:** 3 — Parity-critical core model · **Priority:** P2 · **Parity:** bt
**Deps:** 10, 11 · **Closes:** G4, I3, L2, OQ-5 · **Spec:** §10.3, §9, §14, §1.2, §12.2
---

## Goal
Emit the missing §10.3 per-trade outputs (`t_drop_offset_s`, `error_code`,
`funding_received`), confirm P&L is reported in **percent** (OQ-5), add the §14
conservatism report, and verify the §9 selection guards are replicated in
backtest selection (G4).

## Spec anchors
- §10.3 — per-trade outputs: `delta_pnl` (%), `funding_pnl` (%), `fee_cost` (%), `net_pnl` (%), `exit_reason`, `error_code`, `hold_duration_s`, `fill_count`, `funding_received` (bool), `t_drop_offset_s` (= `T_drop − T_settle`, `null` if `no_drop_localized`).
- §1.2 — units: `0.3` means 0.30%; P&L in percent of notional.
- §12.2 — `error_code` enum (emitted when no position resulted).
- §9 — engine guards replicated at selection: within 0.1pp of threshold; skip snapshots older than 60s; most-negative-first ordering.
- §14 — conservatism report: list active conservatisms + measured P&L bias where computable.

## Files to read
- `src/backtesting/reporting/types.ts:73-91` — `TradeLogEntry` (emits `delta_pnl`/`spread_pnl`/`funding_pnl`/`fees`/`net_pnl`/`exit_reason`/`hold_duration`, but not `error_code`/`t_drop_offset_s`/`no_drop_localized`).
- `src/backtesting/reporting/report-builder.ts:166-201` — trade-log mapping (line 176 `delta_pnl: t.pnl.delta_pnl`, no ×100).
- `src/backtesting/strategies/types.ts:6-47` — `TradeResult` (has `funding_received`, `real_settlement_ts`/`real_settlement_drop` internal only; no `error_code`/`t_drop_offset_s`).
- `src/backtesting/pnl/calculator.ts:18-23` — `calculateDeltaPnl` returns a **fraction** (no ×100).
- `src/backtesting/engine/backtest-runner.ts:293-320` — standard selection loop (threshold via `queryFundingEvents`; no 0.1pp / 60s-stale guard).
- Task 10 output (`error_code` registry / plumbing), Task 11 output (`no_drop_localized`, localized `T_drop`).

## Files to edit
- `src/backtesting/strategies/types.ts` — add `error_code`, `t_drop_offset_s`, surface `no_drop_localized` on `TradeResult`.
- `src/backtesting/reporting/types.ts` — add the fields to `TradeLogEntry` + a conservatism section on `BacktestReport`.
- `src/backtesting/reporting/report-builder.ts` — populate new fields; confirm/fix percent units; build the conservatism list.
- `src/backtesting/engine/backtest-runner.ts` — replicate §9 selection guards (or verify existing coverage).
- Tests: report-builder / reporting fixtures.

## The change (numbered)
1. **Emit `t_drop_offset_s`.** `= T_drop − T_settle` in seconds; `null` when `no_drop_localized` (from Task 11). Today only internal `real_settlement_ts`/`real_settlement_drop` (strategies/types.ts:41-46) exist. Add `t_drop_offset_s` to `TradeResult` and `TradeLogEntry`, compute from the localized timestamp minus `event.funding_time`.
2. **Emit `error_code`.** From Task 10's registry (§12.2), for intents that terminated without a managed position (e.g. `limit_expired`, `ladder_no_fills`). Add to `TradeResult`/`TradeLogEntry` and thread through report-builder.ts:169-183.
3. **Emit `funding_received` (bool).** Already on `TradeResult` (strategies/types.ts:29) but not surfaced in `TradeLogEntry` (types.ts:73-91) or the mapping (report-builder.ts:169-183). Add it.
4. **OQ-5 — units.** `calculateDeltaPnl` (calculator.ts:18-23) returns a fraction (`(exit−entry)/entry`), and report-builder.ts:176 copies `t.pnl.delta_pnl` with no ×100 — so the trade log currently emits **fractions**, contradicting §1.2/§10.3 which require percent. Decide and apply one canonical convention: emit `delta_pnl`/`funding_pnl`/`fee_cost`/`net_pnl` in **percent** (×100 at the reporting boundary is the least invasive; converting the P&L core is the alternative). Document the choice and keep it single-source so live/backtest distributions compare directly.
5. **§14 conservatism report.** Add a section to `BacktestReport` listing active conservatisms: trade-through-only limit fills, 1s latency, market slippage on every fill, `T_drop` fallback = latest edge, SL-first / worst-ordering, `ws_event_miss_rate > 0`, `FUNDING_PNL = 0` for all 4.*, settled-rate-as-selection-proxy. Where measurable (latency, slippage, miss rate) include the estimated P&L bias.
6. **§9 selection guards (G4).** Verify the backtest selection replicates: evaluate only symbols within 0.1pp of an enabled threshold; skip funding snapshots older than 60s (no rate observation within 60s before decision → skip); order candidates most-negative-first. backtest-runner.ts:270-278 filters by threshold only — add the 0.1pp band, 60s-stale gate, and ordering, or document where already covered.

## Verification
- A fixture run emits every §10.3 field (`t_drop_offset_s` null on `no_drop_localized`; `error_code` set on no-position outcomes; `funding_received` present) with P&L in **percent**.
- The report includes the conservatism list with bias estimates for latency/slippage/miss-rate.
- A selection test: a symbol outside the 0.1pp band is not evaluated; a >60s-stale snapshot is skipped; candidates are most-negative-first.
- `npm test`, `npm run lint`.

## Notes / blockers / open questions
- **OQ-5:** confirm percent vs fraction with the spec owner before flipping units repo-wide; a wrong flip silently 100×'s every reported P&L.
- Depends on Task 10 (`error_code` plumbing) and Task 11 (`no_drop_localized`, localized `T_drop`).
- `ws_event_miss_rate` and `settled-rate proxy` conservatisms are declared here but their mechanics live in the S1-WS/S2 strategy files — list them, don't implement them here.
