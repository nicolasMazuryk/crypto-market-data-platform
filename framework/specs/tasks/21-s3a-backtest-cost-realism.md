---

# Task 21 — S3a backtest cost-realism confirmation

**Phase:** 5 — Live-only concerns · **Priority:** P3 · **Parity:** bt
**Deps:** 12 · **Closes:** S3a confirm · **Spec:** 04_strategy_3a.md §6 + parity ledger; 00_globals.md §4 (latency/fill), §5.5 (same-candle), §11.1 (S3a co-run guard)

## Goal

Confirm that after Task 12 (global latency + market-slippage model) lands, the S3a backtest
(`src/backtesting/strategies/strategy-3.ts`, variant `'strategy_3a'`) conforms to
`04_strategy_3a.md §6` with **no S3a-specific work remaining**. S3a is the closest-to-spec
backtest in the fleet (OCO, SL-first, TP allowed on `drop_candle` because it is not credit-gated);
its only gap is the latency + market-slippage that Task 12 delivers globally. This is a **thin
confirmation task** — it MAY close as a no-op if Task 12 fully covers it. State that outcome
explicitly.

## Spec anchors

- `04_strategy_3a.md §6` items 1–6: entry fill at `decision + 1 s` at bid − slippage;
  OCO effective from `entry_candle + 1` with the §5.5.1 SL entry-candle exception; TP trade-through
  only (`low < P_TP` strictly), allowed on `drop_candle` but **not** the entry-fill candle; funding
  charged `−|F_settled|` iff open at `T_settle` (fill-time test).
- `04_strategy_3a.md §6` parity ledger: kill-switch / co-run guard "not modeled (operational/config-time)".
- `00_globals.md §4` — `order_latency_ms = 1000`, `market_slippage_pct = 0.05`, trade-through-only limits.
- `00_globals.md §5.5.1` — only the SL may exit on the entry-fill candle; non-SL exit eval from `entry_candle + 1`.
- `00_globals.md §11.1` — S3a co-run guard: loader rejects `strategy_3a` enabled alongside any LONG strategy; S6 exempt.

## Files to read

- `src/backtesting/strategies/strategy-3.ts` (constructor takes `variant: 'strategy_3a' | 'strategy_3b'`, line 25-26; TP variant A = `|F|×1.5`, line 16).
- `docs-strategy/strategies/04_strategy_3a.md` §6 + parity ledger.
- `src/execution/config/schema.ts:346-364` — co-run guard already implemented: 3a/3b mutual
  exclusion (346-349), LONG-vs-SHORT rejection (351-364); S6 is **not** in the `hasLong` list so it is exempt.
- Task 12 deliverable (latency + `market_slippage_pct`) once landed.

## Files to edit

- None expected. This is a verification/confirmation task. If Task 12 leaves an S3a-specific gap,
  edit `src/backtesting/strategies/strategy-3.ts` to close only that gap (do not re-derive shared logic).

## The change (numbered)

1. After Task 12 merges, run an S3a e2e replay and assert the applied fill model:
   entry at `decision + 1 s`, bid − `market_slippage_pct`; SL/TP effective from `entry_candle + 1`;
   SL exception fires on the entry candle when the range spans the stop (SL-first, pessimistic).
2. Assert TP fills are trade-through-only (`low < P_TP` strictly) and that a TP fill IS permitted on
   `drop_candle` (not credit-gated) but IS NOT permitted on the entry-fill candle.
3. Assert funding is charged `−|F_settled|` iff the position is open at `T_settle` (fill-time test),
   including the pre-settle-exit → `FUNDING_PNL = 0` edge case (§4 funding edge case).
4. Confirm the S3a co-run guard already exists at `src/execution/config/schema.ts:351-364` and rejects
   `strategy_3a` + any LONG strategy (e.g. `strategy_1`), with S6 exempt. No code change — this is a
   parity-ledger "not modeled (config-time)" item, satisfied by the loader guard.
5. Record the outcome: if items 1–3 are fully covered by Task 12 and item 4 by the existing loader,
   **close this task as a no-op** and note it explicitly in the parity ledger.

## Verification

- S3a e2e replay shows Task-12 latency + slippage applied to entry, SL, and deadline fills.
- Co-run guard test: loading a config with `strategy_3a` + `strategy_1` both enabled throws
  `ConfigError('strategies', ...)` (`src/execution/config/schema.ts:359-364`).
- Diff of S3a P&L distribution pre/post Task 12 shows the expected cost drag (worse entries/exits).

## Notes / blockers / open questions

- Blocked on Task 12 landing first.
- Likely no-op — declare that explicitly rather than inventing S3a-only work.
- Co-run guard is config-time and already present; it is intentionally "not modeled" in the backtest
  parity ledger, satisfied purely by the loader.
