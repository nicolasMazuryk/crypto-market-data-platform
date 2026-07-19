---
# Task 18 — S2 backtest: fix the causal trailing tracker

**Phase:** 4 — Per-strategy conformance · **Priority:** P1 · **Parity:** bt
**Deps:** 11, 12, 13, 14 · **Closes:** S2 backtest, C3, C6, R8 · **Spec:** `03_strategy_2.md` §6; `00_globals.md` §5.3, §5.5, §3
---

## Goal
Make S2's trailing-retracement tracker causal and correctly anchored. Three defects:
(a) the running low accumulates from `T_settle`, not from `T_drop` arming, so the
simulated tracker sees pre-drop lows the live tracker never sees (§5.3 violation);
(b) the retracement anchor uses the price at `T_settle` instead of the entry-decision
reference price; (c) there is no WS-miss timeout arming path.

## Spec anchors
- `03_strategy_2.md` §6.2 — tracker arms at `T_drop`, or at `T_settle + funding_fee_timeout_seconds` with prob `ws_event_miss_rate`, or at the `no_drop_localized` window edge. **Never at `T_settle`** (arming there lets the simulated tracker see lows the live tracker never sees, `00_globals.md` §5.3).
- `03_strategy_2.md` §6.3 — causal tracker: from the arming candle onward, once per candle update `P_low_running = min(...)`; a re-placed TP becomes effective on the **next** candle (1 s latency + throttle); ≤ 1 re-place per candle.
- `03_strategy_2.md` §6.4 — TP fills on trade-through only, strictly after `drop_candle`, never on the low-setting candle, never on the entry candle; maker.
- `03_strategy_2.md` step 1 / §5 — anchor = reference price at decision time `T_settle − entry_offset_seconds` (the entry-decision reference), `P_target = P_low + (anchor − P_low) × retracementPct`.
- `00_globals.md` §5.5.3 — SL-first on any candle spanning both SL and TP; §5.5.4 entry-vs-SL same candle.

## Files to read
- `src/backtesting/strategies/strategy-2.ts` — full file; defects at lines 63–65 (anchor) and 105 (running-low start bound).
- `src/backtesting/data/funding-settlement.ts` — `T_drop` localizer (post-Task 11).
- `src/backtesting/orders/limit-order.ts`, `src/backtesting/orders/stop-order.ts` — `checkLimitFill` / `checkStopFill` used by the loop.
- `src/backtesting/strategies/strategy-2.test.ts` (if present) — existing tests.

## Files to edit
- `src/backtesting/strategies/strategy-2.ts` — arming bound, anchor source, timeout arming path.
- `src/backtesting/config/schema.ts` / `loader.ts` — ensure `ws_event_miss_rate`, `funding_fee_timeout_seconds` present for S2 (canonical schema).
- S2 unit tests.

## The change (numbered)
1. **Arm from `T_drop`, not `T_settle`.** Today the running-low update is gated by
   `row.ts >= fundingTs` (strategy-2.ts:105), where `fundingTs = T_settle`
   (strategy-2.ts:52). Re-gate the running-min accumulation to start at the **arming
   time** = `T_drop` (from the localizer). Lows printed between `T_settle` and `T_drop`
   must NOT enter `P_low_running` (§5.3).
2. **Anchor = entry-decision reference price.** Today the anchor is
   `fundingCandle.bid_open` at `T_settle` (strategy-2.ts:63–65, `pFunding`). Per
   `03_strategy_2.md` step 1 the anchor is the reference price at decision time
   `T_settle − entry_offset_seconds`. Re-point the anchor to the entry-decision candle's
   reference price (the same price basis used for the entry decision), not the `T_settle`
   candle. Keep the trailing formula `P_target = P_low + (anchor − P_low) × retracementPct`.
3. **Add the WS-miss timeout arming path.** With prob `ws_event_miss_rate` (seeded, Task 14),
   arm the tracker at `T_settle + funding_fee_timeout_seconds` instead of `T_drop`. Add the
   `no_drop_localized` fallback (arm at the window edge). This mirrors §6.2's three arming sources.
4. **Preserve the already-correct behaviors** (do not regress): causal running-min;
   next-candle effectiveness of a re-placed TP; ≤ 1 re-place per second; TP trade-through
   fills strictly after `drop_candle` and never on the low-setting candle; SL-first same-candle
   resolution (strategy-2.ts:95–99). Keep SL active from entry per §6.1.
5. **Report** deadline-exit frequency (path mix `tp_hit` / `sl_hit` / `deadline`) as required by `03_strategy_2.md` §6.8.

## Verification
- Unit test — arming: fixture with a low between `T_settle` and `T_drop` deeper than any post-`T_drop` low; assert that low is IGNORED (tracker armed at `T_drop`) — `P_low_running` reflects only post-arming lows.
- Unit test — anchor: assert the anchor equals the entry-decision reference price (`T_settle − entry_offset_seconds`), not the `T_settle` candle's `bid_open`.
- Unit test — timeout arming: with the miss drawn, the tracker arms at `T_settle + funding_fee_timeout_seconds`.
- Report includes deadline-exit frequency.
- `npm test`, `npm run lint`.

## Notes / blockers / open questions
- **OQ (anchor basis):** confirm the exact price field for the entry-decision reference (bid_open vs ask_open vs mid) — S2 §5 says "reference price at decision time"; align with the entry fill basis used at strategy-2.ts:58. Note the current `pFunding = fundingCandle.bid_open` at strategy-2.ts:63 is the wrong candle regardless.
- Depends on Task 11 (`T_drop` localizer), Task 13 (`TradeResult` / exit-reason enum), Task 14 (seeded miss RNG). Task 12 if fill primitives are refactored.
- `retracement_pct` is a fraction [0,1] — the loader must reject `> 1.0` (`03_strategy_2.md` §5 defect callout); ensure that guard exists (may be Task 06/05 scope).
