# Task 06 — Hard parameter bounds

**Phase:** 2 — Shared foundations & contracts · **Priority:** P0 · **Parity:** cfg
**Deps:** 05 · **Closes:** H2, H9, H10, H12, S4.2a-guard, R2, R3 · **Spec:** `00_globals.md` §11.1, §13-R2/R3

## Goal
Enforce **every** §11.1 bound (lines 249–265) in **both** loaders, sourced from the canonical registry (Task 05). Violations fail the run. Today the live zod is nearly bound-free and the backtest bounds that exist are **wrong values**.

## Spec anchors
- `00_globals.md` §11.1 bounds table (lines 249–265).
- §13-R2 (line 352) — `exit_offset_seconds > 5`, proposed 6; supersedes source `≥2`/live 4.
- §13-R3 (line 353) — `deadline_seconds` 10–3600; supersedes source 2–180.

## Files to read
- `00_globals.md` §11.1 (249–265).
- `src/execution/config/schema.ts:79-171` — current live zod (mostly plain `z.number()`).
- `src/backtesting/config/loader.ts:283-438` — current backtest `requireIntInRange`/`requirePositiveNumber` calls.
- `live-configs/strategies/strategy_1-*.yaml` (all six) — carry `exitOffsetSeconds: 4` at line 7.
- `framework/specs/gap-analysis.md` lines 111, 117–120.

## Files to edit
- Canonical registry (`src/config/canonical-params.ts` from Task 05) — populate `bounds` per row.
- `src/execution/config/schema.ts` — bounds emitted into the generated zod (`.min`/`.max`/`.refine`).
- `src/backtesting/config/loader.ts` — bounds emitted into the generated backtest validator.
- `live-configs/strategies/strategy_1-*.yaml` — migrate `exitOffsetSeconds: 4` → `6`.

## The change (numbered)
1. **Fix wrong backtest bounds** (`loader.ts`):
   - `exit_offset_seconds`: currently `requireIntInRange(…, 2, 5, …)` (`loader.ts:298`) — **forbids 6**. Change to **≥ 6** (R2).
   - `deadline_seconds`: currently `5..900` (S2, `loader.ts:309`), `3..900` (S3a, `:329`), `10..900` (S4.1a `:345`, S4.2a `:359`) — change all to **10..3600** (R3).
   - `ladder_count`: currently `2..8` (`loader.ts:341`) — change to **2..20**.
   - `retracement_pct`: currently `requirePositiveNumber` with **no upper cap** (`loader.ts:308`) — enforce **0 < v ≤ 1.0** (H12).
   - `ladder_bottom_mult > ladder_top_mult`: **no cross-field check** in backtest today (`loader.ts:342-343`) — add the refinement (live already has it at `schema.ts:127`).
2. **Add live zod bounds** (`schema.ts`) — currently only `retracementPct.max(1)` (`:103`), `ladderCount.min(2)` (`:118`), and two `.refine` (`:127`, `:143`) exist; everything else is plain `z.number()`. Emit the full §11.1 table.
3. **Add bounds missing on BOTH sides:**
   - `sl_multiplier`: **0.5–4.0** (S2, S4.1a, S6); **1.0–4.0 AND > `limit_offset_mult`** (S4.2a — the live refine at `schema.ts:143` checks `>` but not the 1.0–4.0 range; backtest checks neither).
   - `funding_fee_timeout_seconds`: **5–120**.
   - `take_profit_pct`: **0.05–5.0** (the ≥0.05 floor is also the unit guard — Task 07 restates the `unit_suspect_fraction` error message; the numeric bound belongs here).
   - `negative_funding_threshold_percent`: **−5.0 ≤ v < 0** (signed).
   - `funding_threshold_percent` (S6): **−5.0 ≤ v ≤ 5.0** (signed; 0 = always-on).
   - `stop_loss_percent`: **0.2–5.0**.
   - `entry_offset_seconds`: **≥ 2**.
4. **Migrate offending live YAMLs.** `live-configs/strategies/strategy_1-*.yaml:7` carry `exitOffsetSeconds: 4`, which the new ≥6 bound rejects. **Migrate the value to 6** (do not add an alias — 4 is simply now out of bounds per R2).

## Verification
- Unit test **per bound**: a below-min value and an above-max value each rejected with a clear message; an in-range value accepted. Cover both loaders.
- Cross-field: `ladder_bottom_mult ≤ ladder_top_mult` rejected (both sides); `sl_multiplier ≤ limit_offset_mult` rejected for S4.2a (both sides).
- Config-load test: migrated `strategy_1-binance.yaml` (now `exitOffsetSeconds: 6`) loads clean; a fixture with `4` is rejected.
- `deadline_seconds: 1800` (real live value) now accepted; `deadline_seconds: 5` rejected.
- `npm test` + `npm run lint` clean.

## Notes / blockers / open questions
- Depends on Task 05 — bounds are populated as registry data there and emitted here; do not hand-write range checks in either loader.
- R2 note (§13-R2): moving S1 to `exitOffsetSeconds: 6` **changes S1's economics** vs the 4 s live history — flag for backtest re-validation (Task 16), but the bound migration is in scope here.
- The `take_profit_pct` floor (0.05) is shared with Task 07's unit guard — coordinate the error code/message so it reads `unit_suspect_fraction`, not a generic range error.
