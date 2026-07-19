# Task 08 — CI schema round-trip test

**Phase:** 2 — Shared foundations & contracts · **Priority:** P1 · **Parity:** cfg
**Deps:** 05 · **Closes:** H6 · **Spec:** `00_globals.md` §11.2.4

## Goal

Add the §11.2.4 CI round-trip test: **every** canonical parameter is emitted to both the backtest (snake_case) and live (camelCase) schemas, re-parsed, and compared **numerically**. The test is the deliverable and must **fail if the two schemas ever drift** on any parameter (name, unit, default, or bound).

## Spec anchors

- `00_globals.md` §11.2.4 (line 274) — "Round-trip test in CI: every canonical parameter is emitted to both schemas, re-parsed, and compared numerically."
- §11.2.1 (line 271) — single-source generation this test protects.

## Files to read

- `00_globals.md` §11.2 (267–274).
- Canonical registry (Task 05 output) — the enumerable source of parameters to iterate.
- `src/execution/config/schema.test.ts` — existing coverage is only `fundingTimeOverride` (146 lines; no cross-schema test).
- `src/execution/config/loader.test.ts` — only credentials/env-prefix coverage.
- `src/backtesting/__tests__/config-loader.test.ts` — existing backtest loader test (no cross-schema comparison).

## Files to edit

- **New:** a cross-schema round-trip test (proposed `src/config/__tests__/schema-roundtrip.test.ts`, or colocated under `src/execution/config/`), runnable under `npm test` (which runs in CI).

## The change (numbered)

1. **Iterate the canonical registry.** For each parameter (and each strategy that uses it), build a representative value set: default, min bound, max bound, and one mid value.
2. **Emit → parse both sides.** Render each value through the generated backtest snake_case validator and the generated live camelCase zod, for the strategies where the param applies.
3. **Numeric compare.** Assert the parsed numeric value is identical on both sides for accepted values, and that both sides reject the same out-of-bounds / wrong-unit values (agreement on the accept/reject verdict, not just on accepted values).
4. **Drift trip-wire.** Add an assertion that the set of canonical params equals the set of keys each generated schema actually exposes — so adding a param to one hand-edited side (or forgetting to regenerate) fails the test. This is the "fail if the two schemas drift" guarantee.
5. Ensure it runs in the default `npm test` path (no separate opt-in), so CI enforces it.

## Verification

- The new test passes on the current (post-Task-05) generated schemas.
- Deliberately mutating one generated side in a scratch branch (e.g. change a default or drop a key) makes the test **fail** — demonstrate the trip-wire works.
- `npm test` green; `npm run lint` clean.

## Notes / blockers / open questions

- Depends only on Task 05 (needs the canonical registry to iterate and both generators to exist). Does not need Tasks 06/07, but if run after them the bound/unit rejections give richer verdict-agreement coverage.
- Keep the test data-driven off the registry (no hand-listed param names) — a hand-listed test would itself drift and defeat the purpose.
