---
# Task 20 — S4.2a: R11 single-limit lifecycle (both engines)

**Phase:** 4 — Per-strategy conformance · **Priority:** P1 · **Parity:** both
**Deps:** 06, 10, 12, 14 · **Closes:** S4.2a, C8, I2, L1, R5, R7, R11 · **Spec:** `06_strategy_4_2a.md` §2, §6; `00_globals.md` §13-R11, §13-R7, §13-R5, §5.5.4, §G-R
---

## Goal
Implement the R11 single-limit lifecycle in BOTH engines. The conditional SL must be
placed WITH the entry limit at `P_SL = P_limit × (1 − |F| × slMultiplier/100)`
(not after the fill, not anchored to the fill price). The `limit_expired` no-fill
terminal must exist (R5). `FUNDING_PNL = 0` unconditionally (R7), including
pre-settlement fills. Loader must guarantee `slMultiplier > limitOffsetMult` so `P_SL < P_limit`.

## Spec anchors
- `06_strategy_4_2a.md` §2 step 1 — place the conditional SL WITH the entry limit at `P_SL = P_limit × (1 − |F| × slMultiplier/100)` (computable in advance); loader guarantees `slMultiplier > limitOffsetMult`, so `P_SL < P_limit` always.
- `06_strategy_4_2a.md` §2 step 4 / §3 — `limit_expired` terminal: limit never fills by `expireAt = T_settle + deadlineSeconds` → cancel, `error_code = limit_expired`, zero P&L/fees (R5).
- `06_strategy_4_2a.md` §2 step 2 — TP on fill at `P_fill × (1 + takeProfitPct/100)`, maker.
- `06_strategy_4_2a.md` §6.3–6.4 / `00_globals.md` §5.5.4 — TP effective next candle, `drop_candle + 1` discipline, never on the entry-fill candle; entry-vs-SL same candle → both fire, worst outcome.
- `00_globals.md` §13-R7, §G-R — `FUNDING_PNL = 0` unconditional incl. pre-settlement fills.

## Files to read
- Backtest: `src/backtesting/strategies/strategy-4-2.ts` — full file (pre-R11, wrong).
- Backtest: `src/backtesting/orders/simulator.ts`, `orders/limit-order.ts` — fill primitives.
- Backtest: `src/backtesting/pnl/funding-applicability.ts`, `pnl/calculator.ts`.
- Live: `src/execution/execution/manager.ts:3545` (`setError 'limit_expired'` — conforming terminal); `manager.ts:577–610` (`handleEntryFilled` — SL from fill price, wrong).
- Live: `src/execution/strategies/strategy_4_2a.ts` (if present).
- Configs: `live-configs/strategies/strategy_4_2a-*.yaml` (OQ-8 — wrong shape).

## Files to edit
- `src/backtesting/strategies/strategy-4-2.ts` — SL with limit; `limit_expired`; `FUNDING_PNL = 0`.
- `src/backtesting/pnl/*` — force `FUNDING_PNL = 0` for 4.*.
- `src/execution/execution/manager.ts` / `src/execution/strategies/strategy_4_2a.ts` — place conditional SL with the entry limit (anchored to `P_limit`, not fill).
- `live-configs/strategies/strategy_4_2a-*.yaml` — regenerate from canonical schema (OQ-8).
- Unit + parity tests both engines.

## The change (numbered)
### Backtest (`strategy-4-2.ts`)
1. **SL with the limit.** Place the conditional SL at `P_SL = P_limit × (1 − |F| × sl_multiplier)`
   (computable from `P_limit` at placement), active from the placement candle conditional on
   filled qty > 0. Today the SL is placed after the fill from `entryIdx + 1` and anchored to the
   FILL price: `slPrice = entryFill.price × (1 − absF × sl_mult)` (strategy-4-2.ts:72) with orders
   built from `postEntryRows = windowRows.slice(entryIdx + 1)` and `validFrom: firstPostRow.ts`
   (strategy-4-2.ts:75, :89). Re-anchor to `P_limit` and place with the limit.
2. **`limit_expired` terminal.** If the limit never fills by `expireAt = T_settle + deadline_seconds`,
   terminate with `error_code = limit_expired` (Task 10 registry), zero P&L/fees. Today the code
   `return null` when no fill (strategy-4-2.ts:70) — replace with the terminal result.
3. **TP on fill.** `P_fill × (1 + take_profit_pct/100)`, maker; effective `fill_candle + 1`
   (or `drop_candle + 1` if the fill is on `drop_candle`); never on the entry-fill candle.
4. **`FUNDING_PNL = 0` unconditional.** Stop calling `shouldApplyFunding` for accrual
   (strategy-4-2.ts:133) — book `FUNDING_PNL = 0` for all 4.* paths including pre-settlement fills (R7).
5. **Entry-vs-SL same candle.** With `sl_multiplier > limit_offset_mult`, on a deep drop candle both
   fire — model worst outcome (filled and stopped same second, §5.5.4).

### Live (`manager.ts`, `strategy_4_2a.ts`)
6. **Place the conditional SL with the entry limit** at `P_SL = P_limit × (1 − |F| × slMultiplier/100)`,
   replacing the post-fill fill-anchored SL in `handleEntryFilled` (manager.ts:577–610). The
   `limit_expired` terminal (manager.ts:3545) already conforms — keep it.
7. **Loader constraint.** Guarantee `slMultiplier > limitOffsetMult` (Task 06) so `P_SL < P_limit`.

## Verification
- Parity: SL trigger price in both engines equals `P_limit × (1 − |F| × slMultiplier/100)` (P_limit-derived, not fill-derived), for a shared fixture.
- Unit (both): limit never fills by `expireAt` → `limit_expired`, zero fees, no position.
- Unit (both): a pre-settlement fill yields `FUNDING_PNL = 0`.
- Unit (both): entry limit and SL both inside one drop candle → both fire, worst outcome.
- Loader test: `slMultiplier ≤ limitOffsetMult` is rejected.
- `npm test`, `npm run lint`; live: execution engine suite.

## Notes / blockers / open questions
- **BLOCKER OQ-8:** `live-configs/strategies/strategy_4_2a-*.yaml` (binance, bitget, bybit, gateio, kucoin, okx) are in backtest snake_case shape and parse to a zero-strategy engine; they must be regenerated from the canonical schema (Task 05) before live S4.2a can validate. Do this before enabling live.
- Depends on Task 06 (`slMultiplier > limitOffsetMult` bound + config), Task 10 (`error_code` registry incl. `limit_expired`), Task 12 (fill primitives), Task 14 (fixtures).
- `take_profit_pct` unit guard (`< 0.05 → unit_suspect_fraction`) applies here too — same hazard as S4.1a.
- Note: spec `06_strategy_4_2a.md` §2 cites `manager.ts:2642` for `limit_expired`; the actual conforming `setError('limit_expired', ...)` is at `manager.ts:3545` — use 3545.
