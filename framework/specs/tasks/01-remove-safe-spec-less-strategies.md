# Task 01 — Remove safe spec-less strategies (4_1b, 4_2b, 4_3b, spot_futures)

**Phase:** 1 — Surface reduction · **Priority:** P1 · **Parity:** none
**Deps:** none · **Closes:** strategy_4_1b, strategy_4_2b, strategy_4_3b, strategy_spot_futures · **Spec:** docs-strategy/strategies/00_globals.md §Inventory

## Goal
Delete the four spec-less strategy IDs that are **not referenced by any live-config, fleet
enum, or active autoresearch matrix row**: `strategy_4_1b`, `strategy_4_2b`, `strategy_4_3b`,
`strategy_spot_futures`. These are the lowest-risk removals — they live only in the backtesting
surface (plus one dedicated spot-futures engine path). `strategy_4_3a` is intentionally left for
Task 02 (it is exec-wired); the shared file `strategy-4-3.ts` is therefore NOT deleted here — only
its `_4_3b` variant branch is stripped.

## Spec anchors
- 00_globals.md §Inventory lists the canonical set only: 1, 1 WS, 2, 3a, 4.1a, 4.2a, 6. Every ID
  in this task is absent from that table → spec-less → remove.
- §14 Conservatism / spot-futures has no spec entry; the `calculateSpotFuturesPnl` path is orphaned once the ID is gone.

## Files to read
- src/backtesting/strategies/registry.ts (createStrategy switch)
- src/backtesting/strategies/strategy-4-1.ts, strategy-4-2.ts (variant ctors — keep the `a` branch)
- src/backtesting/strategies/strategy-spot-futures.ts (whole file — delete)
- src/backtesting/config/schema.ts (interfaces, StrategyConfig union, VALID_STRATEGY_IDS)
- src/backtesting/config/loader.ts (per-id switch)
- src/backtesting/engine/backtest-runner.ts (spot-futures special path)
- src/backtesting/pnl/calculator.ts (calculateSpotFuturesPnl)
- src/autoresearch/worktree/manager.ts (spot-futures YAML patch)

## Files to edit / delete
Edit:
- src/backtesting/strategies/registry.ts:30-31 (drop `case 'strategy_4_1b'`), :34-35 (`_4_2b`), :38-39 (`_4_3b`), :10 + :42-43 (`SpotFuturesStrategy` import + `case 'strategy_spot_futures'`)
- src/backtesting/strategies/strategy-4-1.ts:25 — narrow ctor `variant` type to `'strategy_4_1a'` only
- src/backtesting/strategies/strategy-4-2.ts:25 — narrow ctor `variant` type to `'strategy_4_2a'` only
- src/backtesting/config/schema.ts — Strategy41Config:158 → `'strategy_4_1a'`; Strategy42Config:181 → `'strategy_4_2a'`; Strategy43Config:199 drop `'strategy_4_3b'` (keep `'strategy_4_3a'` for Task 02); remove `SpotFuturesConfig` (interface ~236-249) + `spot_fees` field:97 + its BaseConfig usage; drop `SpotFuturesConfig` from `StrategyConfig` union (~282); remove `'strategy_4_1b'`:276, `'strategy_4_2b'`:278, `'strategy_4_3b'`:280, `'strategy_spot_futures'`:282 from VALID_STRATEGY_IDS
- src/backtesting/config/loader.ts:335 (`case 'strategy_4_1b'`), :351 (`_4_2b`), :365 (`_4_3b`), :414 (`case 'strategy_spot_futures'`)
- src/backtesting/engine/backtest-runner.ts:17 (import), :61-63 + :152 (`executeSpotFutures` branch), :324 (`openAtEndCount` ternary) — remove the entire `strategy_spot_futures` branch
- src/backtesting/pnl/calculator.ts:103 — remove `calculateSpotFuturesPnl` (orphaned once branch above is gone; confirm no other caller)
- config/base_config.yaml:63 — remove the `spot_fees:` block (comment at :58)
- src/autoresearch/worktree/manager.ts:261-264 — remove the `strategy_spot_futures` perp/spot YAML-patch block
- src/backtesting/__tests__/config-loader.test.ts:49-53 (4_1b load test), and VALID-list assertion entries :214 (4_1b), :216 (4_2b), :218 (4_3b), :282-equiv spot_futures
- autoresearch/program.md:89 (heading `strategy_4_1a / strategy_4_1b`), :99 (`strategy_4_2a / strategy_4_2b`) — drop the `b` names
- RESULTS.md:35-40 (strategy_4_1b rows), :47-50 (strategy_4_2b rows) + any 4_3b/spot_futures rows

Delete:
- config/strategies/strategy_4_1b.yaml
- config/strategies/strategy_4_2b.yaml
- config/strategies/strategy_4_3b.yaml
- config/strategies/strategy_spot_futures.yaml
- src/backtesting/strategies/strategy-spot-futures.ts
- src/backtesting/__tests__/e2e/spot-futures.e2e.test.ts
- src/backtesting/engine/backtest-runner.test.ts:45 — remove the spot-futures case (delete file only if it becomes empty; otherwise edit)

## The change (numbered)
1. Strip the `_4_1b` / `_4_2b` variant branches from the shared `strategy-4-1.ts` / `strategy-4-2.ts` (keep `a`); narrow their ctor `variant` types.
2. In `registry.ts` and `loader.ts` remove the `_4_1b`, `_4_2b`, `_4_3b`, and `strategy_spot_futures` cases (leave `strategy_4_3a` in place for Task 02).
3. In `schema.ts` remove the four IDs from `VALID_STRATEGY_IDS`, narrow the `strategy_id` unions, delete `SpotFuturesConfig` + its union member + the `spot_fees` base field.
4. Delete `strategy-spot-futures.ts`, remove the spot-futures branch in `backtest-runner.ts`, and remove the now-orphaned `calculateSpotFuturesPnl`.
5. Remove the spot-futures YAML-patch block in `autoresearch/worktree/manager.ts`.
6. Delete the four backtest config YAMLs, the spot-futures e2e test + runner test case, and the config-loader test assertions.
7. Delete the `spot_fees` block in `base_config.yaml`; update `program.md` headings and `RESULTS.md` rows.

## Verification
- `npm run build` typechecks clean (no dangling union members / imports).
- `npm test` green; existing `strategy-4.e2e.test.ts` (4_1a/4_2a) still passes.
- `grep -rn "strategy_4_1b\|strategy_4_2b\|strategy_4_3b\|strategy_spot_futures" src config autoresearch RESULTS.md` returns zero non-historical hits (docs-strategy prose may retain mentions).
- `grep -rn "SpotFutures\|spot_fees\|calculateSpotFuturesPnl" src config` returns zero hits.

## Notes / blockers
- No blockers: none of these four IDs appear in live-configs/, src/execution/fleet/schema.ts, or an *active* autoresearch matrix row (matrix.yaml:167-182 spot rows are all commented; 4_1b/4_2b/4_3b never had matrix rows).
- Do NOT delete `strategy-4-3.ts` here — only strip its `_4_3b` branch. The file (and its `_4_3a` branch) is removed in Task 02.
- Keep the `strategy_4_3a` VALID_STRATEGY_IDS entry (:279) — Task 02 removes it.
