# Task 10 — Terminal-state enums

**Phase:** 2 — Shared foundations & contracts · **Priority:** P1 · **Parity:** both
**Deps:** 05 · **Closes:** I1, I2, R5, R12 · **Spec:** `00_globals.md` §12.1, §12.2, §13-R12/R5

## Goal
Make `exit_reason` and `error_code` identical across both engines, matching the §12 registries exactly. Rename the divergent enums in **both** backtest and live to the §12.1 vocabulary, and add an `error_code` type to the **backtest** output (§12.2) so `ladder_no_fills` / `limit_expired` are representable instead of `return null`.

## Spec anchors
- `00_globals.md` §12.1 (lines 280–291) — `exit_reason` = `timed | funding_fee_event | funding_fee_timeout | tp_hit | sl_hit | deadline | kill_switch_flatten`.
- §12.2 (lines 292–301) — `error_code` = `kill_switch | limit_expired | ladder_no_fills | <S6 state-machine codes>`.
- §13-R12 (line 362) — kills the ambiguous 4-value enum incl. `MARKET_EXIT`.
- §13-R5 (line 355) — `limit_expired` normative.

## Files to read
- `00_globals.md` §12 (278–301).
- `src/backtesting/config/schema.ts:8-16` — backtest `ExitReason` = `TP_HIT | SL_HIT | DEADLINE | MARKET_EXIT | UNFILLED | FUNDING_FLOOR | SPREAD_TP | SPREAD_SL`.
- `src/backtesting/strategies/strategy-1.ts:97` — emits `exit_reason: 'MARKET_EXIT'` (the value R12 killed).
- `src/execution/execution/types.ts:17-25` — live `ExitReason` = `timed | tp | sl | deadline | kill_switch | error | funding_fee | funding_fee_timeout`.
- `src/execution/execution/manager.ts` — `error_code` already conforms: `setError(…, 'ladder_no_fills')` (`:3412`), `'limit_expired'` (`:3545`), S6 codes (`:2939-3154`, e.g. `pre_funding_order_failed` `:3146`).
- `src/execution/persistence/drizzle/schema.ts:86` — `exitReason: text('exit_reason')` (raw TEXT; no DB-level enum).

## Files to edit
- Canonical registry / shared enum module (Task 05) — define the §12.1/§12.2 enums as the single source both engines import.
- `src/backtesting/config/schema.ts:8-16` — replace `ExitReason` with the §12.1 values; add an `ErrorCode` type (§12.2).
- `src/backtesting/strategies/strategy-1.ts:97` — `MARKET_EXIT` → `timed`. Sweep every backtest strategy for the old values (`TP_HIT`→`tp_hit`, `SL_HIT`→`sl_hit`, `DEADLINE`→`deadline`; `UNFILLED`/`FUNDING_FLOOR`/`SPREAD_*` map to the correct §12.1/§12.2 value or `error_code`).
- Backtest output/result types + report emitters — carry `error_code` where strategies currently `return null` (`ladder_no_fills` for S4.1a, `limit_expired` for S4.2a).
- `src/execution/execution/types.ts:17-25` — rename live values to §12.1: `tp`→`tp_hit`, `sl`→`sl_hit`, `funding_fee`→`funding_fee_event`, `kill_switch`→`kill_switch_flatten`; drop `error` from `exit_reason` (it belongs to `error_code`).
- Live emit sites (`manager.ts` exit-reason assignments) — update to the renamed values.
- **Persistence:** `drizzle/schema.ts:86` writes raw TEXT — either rename at the source (emit canonical strings) or map before persist. Persisted historical rows carry old strings; decide read-time back-compat (see open questions).

## The change (numbered)
1. **Shared enum source.** Define `ExitReason` and `ErrorCode` once (canonical module) with the exact §12.1/§12.2 string values; both engines import — no per-engine literal lists.
2. **Backtest `exit_reason` rename.** Replace the 8-value legacy enum (`schema.ts:8-16`) with §12.1. Map each emit site; `MARKET_EXIT` (S1, `strategy-1.ts:97`) → `timed`.
3. **Backtest `error_code`.** Add the type (absent today) and emit `ladder_no_fills` (S4.1a) / `limit_expired` (S4.2a) instead of `return null`, so simulated distributions match live (§12.2 final line: "A backtest run must emit these same enums").
4. **Live `exit_reason` rename.** `types.ts:17-25` → §12.1 values; update `manager.ts` emit sites. Live `error_code` already conforms — verify, do not churn.
5. **Persistence.** Since `exit_reason` is stored as free TEXT (`schema.ts:86`), emit the canonical strings at write time (rename at source). Provide a mapping shim for reading pre-migration rows if analytics depend on them.

## Verification
- Enum unit tests both engines: only §12.1 values are valid `exit_reason`; only §12.2 values are valid `error_code`.
- A fixture backtest run of S1 emits `timed`, not `MARKET_EXIT`.
- A fixture S4.1a backtest with no rung fills emits `error_code: ladder_no_fills` (not null); S4.2a unfilled limit emits `limit_expired`.
- Grep clean: no `MARKET_EXIT | TP_HIT | SL_HIT | DEADLINE | UNFILLED | FUNDING_FLOOR | SPREAD_TP | SPREAD_SL` in backtest; no bare `'tp' | 'sl' | 'funding_fee' | 'kill_switch'` as `exit_reason` in live.
- `npm test` + `npm run lint` clean.

## Notes / blockers / open questions
- Depends on Task 05 (shared enum lives in / beside the canonical module).
- **OQ — persistence back-compat:** rename-at-source is cleanest but historical `intent.exit_reason` TEXT rows keep old values. Confirm whether any dashboard/analytics query filters on `'tp'`/`'MARKET_EXIT'`; if so, add a read-time mapping or a one-shot data migration. Do not silently break existing queries.
- Live `error` (in the current `exit_reason` union at `types.ts:23`) is a terminal-without-position outcome → belongs to `error_code`, not `exit_reason`. Verify no emit site relies on `exit_reason: 'error'` before removing it.
- This is a **both**-parity task — coordinate the backtest and live renames in one change so the round-trip/enum tests see a consistent vocabulary.
