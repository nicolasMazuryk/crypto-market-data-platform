---
# Task 19 — S4.1a: rebuild the R11 ladder lifecycle (both engines)

**Phase:** 4 — Per-strategy conformance · **Priority:** P0 · **Parity:** both
**Deps:** 06, 10, 12, 14 · **Closes:** S4.1a, B6, B7, I2, L1, R7, R11 · **Spec:** `05_strategy_4_1a.md` §2, §6; `00_globals.md` §13-R11, §13-R7, §G-R, §5.5.4
---

## Goal
Rebuild the R11 ladder order lifecycle in BOTH the live engine and the backtest — the
single most broken strategy. The SL must be placed WITH the ladder at the precomputable
full-ladder average `P_avg_full`; the TP is placed on the first fill and re-placed on each
deeper fill; unfilled rungs are cancelled ONLY at exit/deadline (not at `T_settle`); qty is
split by largest-remainder over the lot step; sub-min-notional rungs are dropped and the
whole symbol is skipped if the top rung fails `minCost`; zero fills → `ladder_no_fills`;
and `FUNDING_PNL = 0` unconditionally (R7) including pre-settlement fills.

## Spec anchors
- `05_strategy_4_1a.md` §2 — normative R11 lifecycle (supersedes the source that placed SL/TP only after post-settlement rung cancellation); identical in live and backtest. SL placed with the ladder at `P_avg_full = Σ prices[i]·qty[i] / Σ qty[i]` over PLACED rungs (precomputable). TP on first fill, re-placed per deeper fill; SL price does NOT move.
- `05_strategy_4_1a.md` §2 step 4 — unfilled rungs cancelled ONLY after TP/SL/deadline; never earlier.
- `05_strategy_4_1a.md` §2 step 6 / §6.8 — zero fills by deadline → `error_code = ladder_no_fills`, fees 0.
- `05_strategy_4_1a.md` §6.1–6.3 — largest-remainder qty split over lot step; sub-min-notional rungs dropped; symbol skipped if top rung fails `minCost`; TP effective next candle, no rung's TP acts on the candle that rung filled; fills inside `drop_candle` → TP from `drop_candle + 1`.
- `05_strategy_4_1a.md` §6.4 / `00_globals.md` §5.5.4 — SL may act on the same candle as a rung fill (worst outcome).
- `00_globals.md` §13-R7, §G-R — `FUNDING_PNL = 0` unconditional for 4.*, incl. pre-settlement fills (logged `pre_settle_fill_count`).

## Files to read
- Backtest: `src/backtesting/strategies/strategy-4-1.ts` — full file (pre-R11, wrong).
- Backtest: `src/backtesting/orders/simulator.ts` — `simulateLadderOrders` / `simulateOrders`.
- Backtest: `src/backtesting/pnl/funding-applicability.ts` — `fundingFractionForLadder` (R7 violation source).
- Backtest: `src/backtesting/pnl/calculator.ts` — `calculateLadderPnl`.
- Live: `src/execution/execution/manager.ts:3362–3434` — the pre-R11 `T_funding` timer (cancels unfilled rungs, arms SL/TP from filled avg); `manager.ts:577–610` — `handleEntryFilled` (SL/TP from fill price).
- Live: `src/execution/strategies/strategy_4_1a.ts` — ladder placement.

## Files to edit
- `src/backtesting/strategies/strategy-4-1.ts` — full lifecycle rewrite.
- `src/backtesting/orders/simulator.ts` — support SL placed with ladder; unfilled rungs alive until exit.
- `src/backtesting/pnl/*` — enforce `FUNDING_PNL = 0` for 4.* (stop routing through `fundingFractionForLadder`).
- `src/execution/execution/manager.ts` — replace the `T_funding` cancel-then-arm timer with the R11 lifecycle.
- `src/execution/strategies/strategy_4_1a.ts` — place SL with the ladder.
- Unit + parity tests both engines.

## The change (numbered)
### Backtest (`strategy-4-1.ts`)
1. **Qty split.** Replace the equal `quantity: 1 / count` (strategy-4-1.ts:66) with a
   largest-remainder distribution of `amountUsd` over the lot step. Drop rungs whose
   notional falls below `minCost` at placement (ladder may go out with fewer than `ladder_count` orders).
2. **Top-rung skip.** If the top (most favorably priced) rung fails `minCost` at the split qty, skip the symbol entirely (no intent) — §G-R feasibility gate.
3. **SL with the ladder.** Compute `P_avg_full = Σ prices[i]·qty[i] / Σ qty[i]` over the
   PLACED rungs (known in advance) and place the conditional SL at
   `P_avg_full × (1 − |F| × sl_multiplier)` effective from the placement candle — NOT after
   the last fill. Today SL+TP are placed only after the last fill (strategy-4-1.ts:99–135 via
   `postFillSliced` from `lastFillTs`); remove that gating.
4. **TP lifecycle.** Place the TP on the FIRST rung fill at `P_avg × (1 + take_profit_pct/100)`
   sized to filled qty; re-place on each deeper fill at the new `P_avg`. TP effective next candle;
   no rung's TP acts on the candle that rung filled; fills inside `drop_candle` → TP from `drop_candle + 1`.
5. **Unfilled rungs alive until exit.** Keep unfilled rungs open until SL/TP/deadline fires;
   cancel them only then (cancel/fill race → protective reduce-only close next candle, taker).
6. **`ladder_no_fills`.** Zero fills by deadline → terminal `error_code = ladder_no_fills`
   (from Task 10 registry), fees 0. Today the code `return null` on zero fills (strategy-4-1.ts:81) — replace with the terminal result.
7. **`FUNDING_PNL = 0` unconditional.** Stop booking funding: today `fundingFractionForLadder`
   (strategy-4-1.ts:164–169) feeds `calculateLadderPnl` — force `FUNDING_PNL = 0` for all 4.* paths
   including pre-settlement fills (R7). Log `pre_settle_fill_count` for audit.
8. **Same-candle:** SL may act with a rung fill on one candle, worst outcome (§5.5.4); rung TP never on its own fill candle.

### Live (`manager.ts`, `strategy_4_1a.ts`)
9. **Remove the `T_funding` cancel-then-arm timer** (manager.ts:3362–3434): it cancels all
   unfilled rungs at `T_settle` and arms one SL/TP from the filled-rung avg — the ladder dies
   at settlement and cannot catch the drop. Replace with: SL placed with the ladder at
   `P_avg_full` (precomputed); TP placed on first fill and re-placed per deeper fill
   (not via `handleEntryFilled`'s fill-price SL at manager.ts:577–610); unfilled rungs cancelled
   only at exit/deadline. Keep the existing `ladder_no_fills` terminal (manager.ts:3412) but move
   its trigger to the deadline/exit path, not the `T_funding` timer.

## Verification
- Parity: same rung prices AND same largest-remainder qty split in both engines for a shared fixture.
- Unit (both): SL trigger price equals `P_avg_full × (1 − |F| × sl_multiplier)` computed at placement (before any fill), and does not move as rungs fill.
- Unit (both): unfilled rungs remain live until the exit fires (a late dip fills a lower rung after the TP is already resting).
- Unit (both): zero fills by deadline → `ladder_no_fills`, zero fees, no position.
- Unit (both): a pre-settlement rung fill yields `FUNDING_PNL = 0` and increments `pre_settle_fill_count`.
- `npm test`, `npm run lint`; live: execution engine unit/integration suite.

## Notes / blockers / open questions
- Depends on Task 06 (`sl_multiplier` bound / config migration), Task 10 (`error_code` registry incl. `ladder_no_fills`), Task 12 (protective-order fill primitives), Task 14 (deterministic fixtures).
- Both configs generated from the canonical schema (`00_globals.md` §11.2) — no hand-written shapes.
- `take_profit_pct` unit guard (`< 0.05 → unit_suspect_fraction`) is the highest-risk key — ensure the loader guard (Task 06/05) is in place before running.
