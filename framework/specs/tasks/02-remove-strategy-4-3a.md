# Task 02 — Remove strategy_4_3a (exec-wired, spec-less)

**Phase:** 1 — Surface reduction · **Priority:** P1 · **Parity:** none
**Deps:** Task 01 · **Closes:** strategy_4_3a · **Spec:** docs-strategy/strategies/00_globals.md §Inventory

## Goal

Remove `strategy_4_3a` — spec-less (absent from §Inventory) but the **only spec-less rule wired
into the execution engine**. With `strategy_4_3b` already gone (Task 01), no variant of the shared
`strategy-4-3.ts` / `strategy_4_3a.ts` survives, so **both files are deleted whole**. Blockers
(6 live-configs) must be cleared first.

## Spec anchors

- 00_globals.md §Inventory canonical set omits 4.3 entirely (only 4.1a and 4.2a are backtestable Group-R rules) → the whole 4.3 family is spec-less.

## Files to read

- src/execution/index.ts (rule wiring)
- src/execution/strategies/strategy_4_3a.ts (exec rule — delete whole)
- src/execution/strategies/types.ts (union + config type)
- src/execution/config/schema.ts (zod literal, per-strategy risk, LONG co-run guard)
- src/execution/fleet/schema.ts (fleet strategy enum)
- src/backtesting/strategies/registry.ts, strategy-4-3.ts, config/schema.ts, config/loader.ts

## Files to edit / delete

Delete FIRST (blockers):

- live-configs/strategies/strategy_4_3a-binance.yaml
- live-configs/strategies/strategy_4_3a-bybit.yaml
- live-configs/strategies/strategy_4_3a-okx.yaml
- live-configs/strategies/strategy_4_3a-bitget.yaml
- live-configs/strategies/strategy_4_3a-gateio.yaml
- live-configs/strategies/strategy_4_3a-kucoin.yaml

Delete:

- src/execution/strategies/strategy_4_3a.ts (whole; header/body at :23,:25,:50-51)
- src/execution/strategies/strategy_4_3a.test.ts
- src/backtesting/strategies/strategy-4-3.ts (whole — no remaining variant after Task 01)
- config/strategies/strategy_4_3a.yaml

Edit:

- src/execution/index.ts:58 (drop `createStrategy4_3aRule` import), :624-626 (drop the `has('strategy_4_3a')` register block)
- src/execution/strategies/types.ts:13 (union member `'strategy_4_3a'`), :140 (its config interface `id: 'strategy_4_3a'`)
- src/execution/config/schema.ts:147 (drop the `z.literal('strategy_4_3a')` discriminated-union arm), :223 (`strategy_4_3a` in per-strategy risk map), :356 (remove `'strategy_4_3a'` from the LONG co-run guard array — keep the guard itself)
- src/execution/fleet/schema.ts:12 (drop `'strategy_4_3a'` from `StrategyNameEnum`)
- src/backtesting/strategies/registry.ts:8 (`Strategy43` import), :36-37 (`case 'strategy_4_3a'`)
- src/backtesting/config/schema.ts:198-199 (delete `Strategy43Config` interface — already narrowed to `_4_3a`-only after Task 01), its `StrategyConfig` union member, and `'strategy_4_3a'`:279 in VALID_STRATEGY_IDS
- src/backtesting/config/loader.ts:364 (`case 'strategy_4_3a'`)
- src/backtesting/**tests**/config-loader.test.ts:217 (`'strategy_4_3a'` VALID-list assertion entry)
- src/backtesting/**tests**/e2e/strategy-4.e2e.test.ts:4 (import), :439-483 (the two `Strategy43('strategy_4_3a')` test cases)
- autoresearch/matrix.yaml:140-156 — remove the commented `strategy_4_3a` rows (housekeeping)

## The change (numbered)

1. Delete the 6 `strategy_4_3a-*.yaml` live-configs (clears the blocker for the fleet enum removal).
2. Delete the exec rule file + its test; remove the import + register block in `index.ts`.
3. Remove the union member (`types.ts`), the zod literal arm and per-strategy risk entry (`config/schema.ts`), and the LONG co-run guard array entry — leaving the guard logic intact for the remaining LONG rules.
4. Drop `'strategy_4_3a'` from `fleet/schema.ts` `StrategyNameEnum`.
5. Delete the backtesting side: `strategy-4-3.ts` (whole), the registry case + import, `Strategy43Config` + union member + VALID_STRATEGY_IDS entry, the loader case, the e2e cases, and the config-loader assertion.
6. Delete `config/strategies/strategy_4_3a.yaml`; scrub the commented matrix rows.

## Verification

- `npm run build` typechecks clean (discriminated unions exhaustive without 4_3a).
- `npm run config:validate` passes (no live-config or fleet entry references the removed ID).
- `npm test` green (execution + backtesting suites).
- `grep -rn "strategy_4_3a\|Strategy43\|strategy-4-3\|createStrategy4_3aRule" src config live-configs autoresearch` returns zero non-historical hits.

## Notes / blockers

- Blocker order matters: the 6 live-configs must be deleted before removing the `StrategyNameEnum` value, or `config:validate` on the existing fleet configs will fail.
- Depends on Task 01: `strategy-4-3.ts` is only whole-deletable once its `_4_3b` branch is already stripped and `Strategy43Config` is narrowed to `_4_3a`-only.
- The LONG-vs-SHORT co-run guard (globals §11.1) stays — only the `strategy_4_3a` element leaves its LONG list.
