# Task 07 — Unit-mismatch protection

**Phase:** 2 — Shared foundations & contracts · **Priority:** P0 · **Parity:** cfg
**Deps:** 05, 06 · **Closes:** H5, H7, R4 · **Spec:** `00_globals.md` §11.2 (§11.2.2/§11.2.3), §13-R4

## Goal
Make wrong-unit config an **error, not a warning**. A take-profit written as a decimal fraction (`0.003` = 0.3 bp) instead of percent (0.3 = 30 bp) must fail both loaders with `unit_suspect_fraction`. Add strict unknown-key rejection so a mis-keyed value cannot be silently dropped.

## Spec anchors
- `00_globals.md` §11.2.3 (line 273) — `take_profit_pct < 0.05 → unit_suspect_fraction` ("value looks like a fraction; percent expected").
- §11.2 (line 269) + §1.2 (line 47) — "A config value in the wrong unit is a **loader error**, not a warning."
- §13-R4 (line 354) — the `takeProfitPct = 0.003` case; highest-risk key in the system.
- §11.1 `retracement_pct` row (line 260) — fraction 0 < v ≤ 1.0.

## Files to read
- `00_globals.md` §11.2 (267–274), §13-R4.
- `src/execution/config/schema.ts:79-171` — live zod objects are **not** `.strict()` (unknown keys silently dropped).
- `src/backtesting/config/loader.ts:283-438` — reads named fields only; extra keys ignored.
- `live-configs/strategies/strategy_4_1a-binance.yaml:9` — `takeProfitPct: 0.003` (loads clean today; must fail).
- `framework/specs/gap-analysis.md` lines 113, 115.

## Files to edit
- Canonical registry / generators (Task 05) — the unit-guard emission.
- `src/execution/config/schema.ts` — `.strict()` on every generated strategy object + the `take_profit`/`retracement` guards.
- `src/backtesting/config/loader.ts` — unknown-key rejection + the same guards.

## The change (numbered)
1. **`take_profit_pct` unit guard.** In both loaders, `take_profit_pct < 0.05` → **hard error** with code/message `unit_suspect_fraction` ("value looks like a fraction; percent expected"). This is the same 0.05 floor as Task 06 but with the unit-specific message — not a generic range error. (`grep -rn unit_suspect src/` is empty today.)
2. **`retracement_pct` upper reject.** `retracement_pct > 1.0` → reject (fraction, not percent). Live already has `.max(1)` (`schema.ts:103`); add to backtest (Task 06 also covers the numeric bound — here ensure the message frames it as a unit/fraction error).
3. **Strict unknown-key rejection.** Add `.strict()` to every live zod strategy object (`schema.ts:80-170` are non-strict → unknown keys dropped, so a typo'd or mis-shaped key vanishes silently). Add equivalent unknown-key rejection to the backtest loader (it currently reads named fields and ignores extras). A key present that is not in the canonical registry for that strategy → error.
4. **Wrong-unit = ERROR everywhere.** No warn-and-continue path. Confirm no coercion (§11.2.1: "rejected, never coerced").

## Verification
- Unit test: `takeProfitPct: 0.003` (from `strategy_4_1a-binance.yaml:9`) **rejected** with `unit_suspect_fraction` on the live side; the snake_case equivalent rejected on the backtest side.
- Unit test: an unknown key (e.g. `takeProfitPercent: 0.3` typo, or a stray `foo: 1`) rejected on both sides — **not** silently dropped.
- Unit test: `retracement_pct: 1.5` rejected.
- Regression: all currently-valid configs (post-Task-06 migration, e.g. `strategy_1-*.yaml` with `exitOffsetSeconds: 6`) still load clean.
- `npm test` + `npm run lint` clean.

## Notes / blockers / open questions
- Depends on Task 05 (canonical registry drives which keys are "known" per strategy) and Task 06 (shares the 0.05 floor — reuse the same threshold, differentiate only the error message).
- `strategy_4_1a-binance.yaml:9` currently ships `0.003` in production live-config — this task makes the fleet config fail to load until corrected. Flag: the value must be fixed to a real percent (spec default 0.2) as part of, or immediately after, this change, or the S4.1a fleet row won't start.
- `.strict()` interacts with zod `discriminatedUnion` — the discriminator key (`id`) must remain allowed; verify strictness is applied to the object variants, not the union wrapper.
