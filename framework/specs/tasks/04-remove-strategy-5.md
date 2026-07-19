# Task 04 — Remove strategy_5 (cross-exchange, backtest-only)

**Phase:** 1 — Surface reduction · **Priority:** P2 · **Parity:** none
**Deps:** none · **Closes:** strategy_5 · **Spec:** docs-strategy/strategies/00_globals.md §Inventory

## Goal

Remove `strategy_5` — a spec-less, backtest-only cross-exchange short. It is absent from
§Inventory and has **no execution wiring**, but it is uniquely entangled: it is the **only active
autoresearch matrix row** and it carries `strategy_5`-specific autoresearch infrastructure
(cross-exchange "pins": `main_exchange` / `exclude_exchanges`, and a dedicated diff-gate guard).
See the open question below on infra scope.

## Spec anchors

- 00_globals.md §Inventory has no `5` row; all canonical strategies are single-exchange. `strategy_5` is a cross-exchange construct with no spec → remove.

## Files to read

- autoresearch/matrix.yaml (the one active row)
- src/backtesting/strategies/registry.ts, strategy-5.ts, config/schema.ts, config/loader.ts
- src/backtesting/engine/backtest-runner.ts (S5 scan branch)
- src/autoresearch/matrix/loader.ts, src/autoresearch/paths.ts, src/autoresearch/types.ts
- src/autoresearch/agent/prompt-builder.ts, src/autoresearch/git/diff-gate.ts

## Files to edit / delete

Delete FIRST (blocker):

- autoresearch/matrix.yaml:160-164 — remove the active `- strategy: strategy_5` row (main_exchange row)

Delete:

- src/backtesting/strategies/strategy-5.ts
- config/strategies/strategy_5.yaml
- autoresearch/best-configs/strategy_5-binance/ (directory)
- src/backtesting/**tests**/e2e/strategy-5.e2e.test.ts

Edit (backtesting):

- src/backtesting/strategies/registry.ts:9 (`Strategy5` import), :40-41 (`case 'strategy_5'`)
- src/backtesting/engine/backtest-runner.ts:16 (import), :43 (`feeExchange` S5 ternary → simplify to `base.exchange`), :190-215 (the `else if strategy_id === 'strategy_5'` cross-exchange scan branch)
- src/backtesting/config/schema.ts:217-218 (`Strategy5Config` interface + its `StrategyConfig` union member) and `'strategy_5'`:281 in VALID_STRATEGY_IDS; also the `funding_time_tolerance_seconds` base field (~line 94) if it is S5-only
- src/backtesting/config/loader.ts:378 (`case 'strategy_5'`)
- src/backtesting/**tests**/config-loader.test.ts:58-80 (the two `strategy_5` config tests), :219 (`'strategy_5'` VALID-list assertion)

Edit (autoresearch infra — see open question):

- src/autoresearch/types.ts:13-… — remove `MatrixRowCross` (the `strategy: 'strategy_5'` shape with `main_exchange` / `exclude_exchanges`)
- src/autoresearch/matrix/loader.ts:59,62,65,71,76,89,155 — remove the `strategy_5` validation/normalization branch and the `only strategy_5 uses main_exchange/exclude_exchanges` guard
- src/autoresearch/paths.ts:50-51 — remove the `strategy_5-${main_exchange}` tag-naming branch
- src/autoresearch/agent/prompt-builder.ts:95-96 — remove the `strategy_5 pins` hard-constraint line (collapse to the else branch)
- src/autoresearch/git/diff-gate.ts:14,21,45-46,60,73 — remove `checkStrategy5Pins` + the `pinnedExchangesMutated` path + the `strategy_5` error message
- src/autoresearch/**tests**/diff-gate.test.ts, matrix-loader.test.ts, prompt-builder.test.ts — remove `strategy_5`-specific cases

## The change (numbered)

1. Delete the active `strategy_5` matrix row (unblocks removal; without it the strategy is unreachable).
2. Backtesting: drop the registry/loader cases, the S5 scan branch + fee ternary in `backtest-runner.ts`, `Strategy5Config` + union member + VALID_STRATEGY_IDS entry, and delete `strategy-5.ts` + its e2e + config YAML + best-configs dir.
3. Autoresearch (full-removal option): unwind the cross-exchange "pins" infra — `MatrixRowCross`, the loader's `main_exchange`/`exclude_exchanges` handling, the `paths.ts` tag branch, the prompt-builder pin line, and `diff-gate`'s `checkStrategy5Pins`.
4. Update the three affected autoresearch tests.

## Verification

- `autoresearch/matrix.yaml` has no `strategy_5` row (active or that resolves to a run).
- `npm run build` typechecks; `npm test` green (autoresearch + backtesting suites, updated).
- `grep -rn "strategy_5\|Strategy5\|checkStrategy5Pins\|MatrixRowCross\|main_exchange\|exclude_exchanges" src autoresearch config` returns zero non-historical hits (allow matrix.yaml header comment scrub).

## Notes / blockers

- **Blocker:** matrix.yaml:161 is the sole _active_ autoresearch row referencing `strategy_5`; delete it first.
- **OPEN QUESTION — infra scope.** Two options:
  - (A) _Minimal_: delete only the matrix row + the backtesting surface (steps 1-2), leaving the autoresearch cross-exchange pins infra dormant (`MatrixRowCross`, `checkStrategy5Pins`, loader/paths/prompt branches). Smaller diff, but leaves dead code keyed on a removed ID.
  - (B) _Full removal_ (steps 1-4): also unwind the `strategy_5`-specific autoresearch pins infra.
  - **Recommendation: (B) full removal** for a clean surface — but flag the autoresearch infra-unwind (matrix loader + diff-gate `checkStrategy5Pins` + prompt-builder + paths tag + `MatrixRowCross` + 3 test files) as the **larger sub-effort**; it touches the cross-exchange abstraction that only `strategy_5` uses, so it can be split into its own follow-up if the diff needs bounding.
- `funding_time_tolerance_seconds` (backtesting config/schema.ts) is documented as S5-only; verify no other strategy reads it before removing.
