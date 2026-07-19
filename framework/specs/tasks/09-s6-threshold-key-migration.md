# Task 09 — S6 threshold key migration

**Phase:** 2 — Shared foundations & contracts · **Priority:** P1 · **Parity:** cfg
**Deps:** 05 · **Closes:** H11, R6 · **Spec:** `00_globals.md` §10.2 (S6 row), §13-R6

## Goal
Canonicalize the S6 funding-threshold key to `fundingThresholdPercent` (live) / `funding_threshold_percent` (backtest). The live engine currently uses the raw snake_case outlier `funding_threshold` inside a camelCase schema. Accept the legacy `funding_threshold` for **one migration cycle** with a deprecation warning, mapping it to the canonical key.

## Spec anchors
- `00_globals.md` §10.2 line 214 — `F_threshold_s6` → live key `fundingThresholdPercent`, **legacy engine key `funding_threshold` — migration alias required**.
- §13-R6 (line 356) — canonical `fundingThresholdPercent`; engine must accept legacy `funding_threshold` one cycle, warn on use.
- §11.1 line 263 — `funding_threshold_percent` (S6) bound **−5.0 ≤ v ≤ 5.0** (signed; 0 = always-on). Enforcement is Task 06's scope; noted here for coordination.

## Files to read
- `00_globals.md` §10.2 (line 214), §13-R6.
- `src/execution/config/schema.ts:162` — `funding_threshold: z.number().default(0)` in the `strategy_6` variant.
- `src/execution/strategies/strategy_6.ts:29` — reads `config.funding_threshold`.
- `src/execution/execution/scheduler.ts:63` — `if (config.id === 'strategy_6') return config.funding_threshold` (note: file is `execution/execution/scheduler.ts`, not `strategies/scheduler.ts`).
- `src/execution/strategies/types.ts:64` — `funding_threshold: number` on `Strategy6Config`.
- `framework/specs/gap-analysis.md` line 119.

## Files to edit
- Canonical registry (Task 05) — S6 threshold entry with canonical key + legacy alias metadata.
- `src/execution/config/schema.ts` — accept `fundingThresholdPercent` (canonical) and legacy `funding_threshold`; preprocess/transform legacy → canonical with a deprecation warn.
- `src/execution/strategies/types.ts:64` — rename field to `fundingThresholdPercent`.
- `src/execution/strategies/strategy_6.ts:29` — read `config.fundingThresholdPercent`.
- `src/execution/execution/scheduler.ts:63` — read `config.fundingThresholdPercent`.
- Any S6 live-config YAML using `funding_threshold` — migrate to `fundingThresholdPercent` (leave one legacy fixture for the alias test).

## The change (numbered)
1. **Canonical key.** Add `fundingThresholdPercent` as the S6 threshold key in the generated live schema (default 0 = always-on), replacing the raw `funding_threshold` at `schema.ts:162`.
2. **Legacy alias, one cycle.** If a config supplies `funding_threshold` (and not `fundingThresholdPercent`), accept it, **emit a deprecation warning**, and map it to `fundingThresholdPercent`. If both are present, prefer canonical (or reject as ambiguous — pick and document).
3. **Update engine reads.** Rename the type field (`types.ts:64`) and the two consumers (`strategy_6.ts:29`, `scheduler.ts:63`) to `fundingThresholdPercent`. The sign semantics are unchanged (`t > 0` fire when rate ≥ t; `t < 0` fire when rate ≤ t; 0 always-on — see `strategy_6.ts:29-31`).
4. **Bound note.** The −5..5 signed bound comes from Task 06; ensure the canonical entry carries it so Task 06 emits it. Do not duplicate the check here.

## Verification
- Unit test: a config with legacy `funding_threshold: -0.4` loads, **emits a deprecation warning**, and resolves to `fundingThresholdPercent = -0.4` consumed by `strategy_6.ts` and `scheduler.ts`.
- Unit test: a config with `fundingThresholdPercent: 0.1` loads clean, no warning.
- Grep: no remaining `config.funding_threshold` reads in engine code (`strategy_6.ts`, `scheduler.ts`, `types.ts`).
- `npm test` + `npm run lint` clean.

## Notes / blockers / open questions
- Depends on Task 05 (alias handled in the generated schema, not hand-patched).
- The backtest side has no S6 (S6 is not backtestable — §Inventory line 343). This migration is live-only reads, but the **canonical key** must still exist in the registry so the round-trip test (Task 08) and bound (Task 06) treat it uniformly.
- Decide and document the "both keys present" behavior (recommend: reject as ambiguous config).
- The deprecation warning is the signal to remove the alias next cycle — leave a TODO/issue reference.
