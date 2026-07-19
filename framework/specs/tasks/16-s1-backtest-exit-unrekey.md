---
# Task 16 — S1 backtest: un-re-key the timed exit off T_drop

**Phase:** 4 — Per-strategy conformance · **Priority:** P1 · **Parity:** bt
**Deps:** 06, 11, 13 · **Closes:** S1 backtest, R2 · **Spec:** `01_strategy_1.md` §6.3, §6.5; `00_globals.md` §13-R2, §3, §5.5.1
---

## Goal

Make the S1 backtest exit key to the **fixed** clock `T_settle + exit_offset_seconds`,
identical to live, NOT to the detected drop instant. Today the backtest re-keys the
exit to the localized settlement/drop time — the forbidden re-keying (R2). A fixed
offset that sometimes lands before the drop (favorable) and sometimes after/inside it
(unfavorable) **is** the strategy; re-keying to `T_drop` simulates a different,
better-informed strategy and must be removed. `T_drop` localization still runs, but
only to record `t_drop_offset_s` for reporting/bucketing.

## Spec anchors

- `01_strategy_1.md` §6.3 — binding resolution (R2): the exit is keyed to the fixed offset, identical to live; the backtest does NOT re-key this exit to `T_drop`; live has no drop-awareness.
- `01_strategy_1.md` §6.5 — `T_drop` localization runs anyway (reporting only); every S1 trade records `t_drop_offset_s` so results bucket by whether the exit preceded the drop.
- `01_strategy_1.md` §4 / §6 — report must break `NET_PNL` down by `t_drop_offset_s` bucket.
- `00_globals.md` §13-R2 — bound `exit_offset_seconds > 5` (≥ 6), proposed 6, identical in live and backtest; exit not re-keyed to `T_drop`. `exit_offset ≥ 6` bound comes from Task 06.
- `00_globals.md` §5.5.1 — non-SL exit evaluation starts at `entry_candle + 1` (trivially satisfied here; keep structural).

## Files to read

- `src/backtesting/strategies/strategy-1.ts` — full file; the exit-keying bug is lines 52–58.
- `src/backtesting/data/funding-settlement.ts` — `detectRealFundingSettlement` (now the §3.1 `T_drop` localizer post-Task 11); still called for reporting only.
- `src/backtesting/strategies/types.ts` — `TradeResult` shape (add `t_drop_offset_s`).
- `src/backtesting/strategies/strategy-1.test.ts` (if present) — existing S1 unit tests.

## Files to edit

- `src/backtesting/strategies/strategy-1.ts` — decouple exit clock from `settlement`; add `t_drop_offset_s`.
- `src/backtesting/strategies/types.ts` — extend `TradeResult` with `t_drop_offset_s` (nullable) if not already present via Task 11/13.
- S1 unit tests — new/updated cases.
- Reporting layer (bucketing by `t_drop_offset_s`) — wherever the backtest report aggregates `TradeResult`s.

## The change (numbered)

1. **Remove the re-key.** Today (strategy-1.ts:52–58) the exit is computed as
   `settlementTime = settlement.settlementTs` (the localized drop time) and
   `exitTime = settlementTime + exit_offset_seconds`. Replace with the fixed clock:
   `exitTime = event.funding_time (= T_settle) + config.exit_offset_seconds * 1000`.
   The exit decision must fire at `T_settle + exit_offset_seconds` regardless of where
   `T_drop` localizes. (Fill still lands at decision + 1 s latency at the bid proxy − slippage, taker — unchanged.)
2. **Keep localization for reporting only.** Continue calling the localizer (post-Task 11 `T_drop` algorithm) but use its result **only** to compute
   `t_drop_offset_s = T_drop − T_settle` (seconds; `null` when `no_drop_localized`, per `00_globals.md` §10.3). Do not let it influence entry, exit, or funding accrual.
3. **Funding accrual key.** `shouldApplyFunding` must test the entry fill time against `T_settle` (`event.funding_time`), per `00_globals.md` §5.1 — not against the localized drop time. Verify the current `fundingTs: settlement.settlementTs` argument (strategy-1.ts:71) is re-pointed to `T_settle`, since the exit is no longer drop-keyed. (Confirm intent with Task 13.)
4. **Emit `t_drop_offset_s`** on the `TradeResult` and replace the ambiguous `exit_reason: 'MARKET_EXIT'` (strategy-1.ts:97) with the canonical `timed` enum value (`00_globals.md` §12.1; may already be handled by Task 13 — coordinate).
5. **Report bucketing.** Ensure the backtest report groups `NET_PNL` by `t_drop_offset_s` bucket (e.g. exit-before-drop vs exit-after/inside-drop), so the "variance is the strategy" claim is auditable.

## Verification

- Unit test: with a fixture where `T_drop` localizes at `T_settle + 8 s` but `exit_offset_seconds = 6`, the exit decision fires at `T_settle + 6 s` (before the drop) — proving the exit clock ignores `T_drop`.
- Unit test: a second fixture with `T_drop` at `T_settle + 2 s` and the same `exit_offset_seconds = 6` still exits at `T_settle + 6 s` — same absolute clock, different drop localization.
- A trade records a non-null `t_drop_offset_s` when localized and `null` on `no_drop_localized`.
- The report contains at least one bucket keyed by `t_drop_offset_s`.
- `npm test`, `npm run lint`.

## Notes / blockers / open questions

- Depends on Task 11 (`T_drop` localizer + `no_drop_localized` flag) and Task 13 (exit-reason enum / `TradeResult` fields) — align on where `t_drop_offset_s` is populated to avoid double-work.
- `exit_offset_seconds ≥ 6` bound and config migration (live history ran 4 s) come from Task 06 — this task assumes the bound is already enforced by the loader.
- Do NOT let localization touch drop-candle prices (`00_globals.md` §3.2) — timestamp only.
