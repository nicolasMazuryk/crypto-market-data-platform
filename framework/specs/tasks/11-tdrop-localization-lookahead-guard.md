---
# Task 11 — T_drop localization + lookahead guard wiring

**Phase:** 3 — Parity-critical core model · **Priority:** P0 · **Parity:** bt
**Deps:** 05, 06 · **Closes:** A1, A2, A3, A4, A5, L1, R1 · **Spec:** §2, §3.1, §3.2, §5.3, §14
---

## Goal
Replace the naïve absolute-price drop detector with the normative §3.1 `T_drop`
localization algorithm, and actually wire the (currently dead) lookahead guard
so strategies can only look ahead within the localization window `W`. Together
these make credit-gated actions fire at `T_drop`, not `T_settle`, and make the
"one sanctioned lookahead" (§3.2) structurally enforced instead of honor-system.

## Spec anchors
- §2 — event timeline: drop clusters in `[T_settle, T_settle+10s]`, not on the `HH:MM:00` candle.
- §3.1 — normative localization algorithm (`drop_move`, `red_range`, `Q`, `R_pre`, argmax, tie-breaks, fallback).
- §3.2 — scope restriction: lookahead permitted **only** to extract `drop_candle`'s timestamp; never its prices/magnitude/existence for trading.
- §5.3 — credit-gated actions occur at `T_drop`.
- §14 — conservatism: fallback = latest window edge (tracker sees fewer lows).

## Files to read
- `src/backtesting/data/funding-settlement.ts` — current detector (to replace).
- `src/backtesting/data/funding-settlement.test.ts` — existing unit tests.
- `src/backtesting/engine/lookahead-guard.ts` — `TimeGatedWindow` / `LookaheadViolationError` (defined, never instantiated).
- `src/backtesting/__tests__/lookahead-guard.test.ts` — existing guard unit tests.
- `src/backtesting/engine/backtest-runner.ts` — standard-strategy loop (`strategy.execute(event, window)` at line 309).
- `src/backtesting/strategies/strategy-2.ts` (getRowsInRange at line 80), `strategy-4-1.ts` (getRowsInRange at line 75) — free lookahead callers.
- `src/backtesting/config/schema.ts:62-68` (`FundingSettlementConfig`), `src/backtesting/config/loader.ts:252-265` (loader), `src/backtesting/data/types.ts` (`OHLCWindow`).

## Files to edit
- `src/backtesting/data/funding-settlement.ts` — new algorithm + fallback flag.
- `src/backtesting/config/schema.ts` — add 3 keys; resolve `detection_window_seconds` (OQ-9).
- `src/backtesting/config/loader.ts` — parse/bound the 3 new keys.
- `src/backtesting/engine/backtest-runner.ts` — wrap the per-event window in `TimeGatedWindow`.
- `src/backtesting/strategies/strategy-1.ts`, `strategy-2.ts` — pass through the localized timestamp / flag; adapt callers.
- Tests: `funding-settlement.test.ts`, `lookahead-guard.test.ts`.

## The change (numbered)
1. **Replace the detector.** Current `detectRealFundingSettlement` (funding-settlement.ts:16-41) computes `bestDrop = max(bid_open − bid_low)` in **absolute price** over `[fundingTime, fundingTime+windowSeconds]` and returns the argmax candle. Rewrite to §3.1:
   - `drop_move(c) = (prev_close(c) − low(c)) / prev_close(c) × 100` (percent).
   - `red_range(c) = (high(c) − low(c)) / open(c) × 100` if `close(c) < open(c)` else 0.
   - `R_pre = median over [T_settle−30s, T_settle−1s] of (high−low)/open × 100`.
   - `Q = max(dropQualifierFundingMult·|F|, dropQualifierRangeMult·R_pre)`.
   - candidate set `= { c in W : drop_move(c) ≥ Q }`; `W = [T_settle, T_settle+dropSearchWindowSeconds]`.
   - `drop_candle = argmax drop_move` (tie-break: larger `red_range`; further tie: earlier candle); `T_drop = drop_candle.open_ts`.
   - Detector needs `|F|` — thread the funding rate into the function signature (currently absent).
2. **Fix the fallback.** Current fallback (funding-settlement.ts:37-38) returns `fundingTs` (= `T_settle`). Per §3.1/§14 it must return `T_settle + dropSearchWindowSeconds` (latest, most conservative arming edge) and set a `no_drop_localized: true` flag on the result. Extend `FundingSettlementResult` with that flag (and drop/rename the absolute `dropMagnitude`).
3. **Add 3 config keys** (§3.1 table, backtest-only): `drop_search_window_seconds` (default 10, bounds [5,30]), `drop_qualifier_funding_mult` (default 0.5, [0.1,2.0]), `drop_qualifier_range_mult` (default 3.0, [1.5,10]). Add to `FundingSettlementConfig` in schema.ts and validate in loader.ts alongside the block at loader.ts:252-265.
4. **Resolve OQ-9.** The existing key `funding_settlement.detection_window_seconds` (schema.ts:65, loader bound 1..60 at loader.ts:262) semantically duplicates `drop_search_window_seconds` but with a different bound. Do **not** keep both silently. Blocker — see below.
5. **Wire the lookahead guard.** In backtest-runner.ts, wrap each per-event `window` in a `TimeGatedWindow` (lookahead-guard.ts) before handing it to `strategy.execute`. Set the gate so strategies may read up to the decision time; localization is the *only* code path allowed to peek to `W`'s edge (do the localization on the raw inner window / a widened gate, then advance the strategy-facing gate no further than the decision boundary). Strategies currently call `getRowsInRange(...)` freely (strategy-2.ts:80, strategy-4-1.ts:75) — these must now throw `LookaheadViolationError` if they request post-decision, non-localization rows.

## Verification
- Unit-test §3.1 on synthetic candles: a drop at `T_settle+3s` localizes `T_drop` to `+3s`; a flat/no-drop window falls back to `T_settle + dropSearchWindowSeconds` with `no_drop_localized = true`. Cover `Q` gated by both `|F|` and `R_pre`, and both tie-breaks.
- Lookahead-guard test: a strategy that reads a post-decision, non-localization row via the gated window throws `LookaheadViolationError`; localization reading `W` does not.
- `npm test`, `npm run lint`.

## Notes / blockers / open questions
- **BLOCKER OQ-9:** decide `detection_window_seconds` vs `drop_search_window_seconds`. Recommended: rename/migrate the old key to `drop_search_window_seconds` with the §3.1 bound [5,30], remove the 1..60 bound, and keep `tp_post_settlement_buffer_seconds` as-is. Must land before Tasks 13/14 depend on the localized boundary.
- Detector signature change ripples into strategy-1.ts:52 and strategy-2.ts:68 call sites.
- Do not use `drop_candle` prices/magnitude for any trading decision (§3.2) — timestamp only.
