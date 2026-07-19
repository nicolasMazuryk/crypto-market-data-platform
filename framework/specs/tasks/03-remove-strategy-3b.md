# Task 03 — Remove strategy_3b (variant of shared strategy_3)

**Phase:** 1 — Surface reduction · **Priority:** P1 · **Parity:** none
**Deps:** none · **Closes:** strategy_3b · **Spec:** docs-strategy/strategies/00_globals.md §Inventory

## Goal

Remove `strategy_3b`. It **shares** `strategy-3.ts` / `strategy_3.ts` with the canonical
`strategy_3a` (§Inventory row `3a`), so strip the `_3b` **variant only** and keep `3a` fully
intact. Blockers: 6 `strategy_3b-*.yaml` live-configs. IMPORTANT: the exec schema carries a
`3a`/`3b` mutual-exclusion refine and a LONG-vs-SHORT co-run guard — after dropping `3b`, the
S3a-vs-LONG co-run guard (globals §11.1) must remain intact.

## Spec anchors

- 00_globals.md §Inventory lists `3a` (SHORT, `sl_tp_deadline`) as canonical; `3b` is absent → spec-less variant.
- globals §11.1 — S3a (SHORT) and LONG strategies cannot both be enabled on the same exchange+symbol; guard must survive `3b` removal.

## Files to read

- src/backtesting/strategies/strategy-3.ts (variant ctor — keep `strategy_3a` branch)
- src/backtesting/strategies/registry.ts, config/schema.ts, config/loader.ts
- src/execution/strategies/strategy_3.ts (variant `'A'`/`'B'` → id — keep `'A'`)
- src/execution/strategies/types.ts, config/schema.ts (literal, risk, 3a/3b refine, tpVariant), fleet/schema.ts

## Files to edit / delete

Delete FIRST (blockers):

- live-configs/strategies/strategy_3b-binance.yaml
- live-configs/strategies/strategy_3b-bybit.yaml
- live-configs/strategies/strategy_3b-okx.yaml
- live-configs/strategies/strategy_3b-bitget.yaml
- live-configs/strategies/strategy_3b-gateio.yaml
- live-configs/strategies/strategy_3b-kucoin.yaml

Delete:

- config/strategies/strategy_3b.yaml

Edit (backtesting):

- src/backtesting/strategies/registry.ts:26-27 — drop `case 'strategy_3b'` (keep `case 'strategy_3a'`)
- src/backtesting/strategies/strategy-3.ts:25 — narrow ctor `variant` type to `'strategy_3a'` only
- src/backtesting/config/schema.ts:137 — narrow `Strategy3Config.strategy_id` to `'strategy_3a'`; remove `'strategy_3b'`:274 from VALID_STRATEGY_IDS
- src/backtesting/config/loader.ts:315 — drop `case 'strategy_3b'`

Edit (execution):

- src/execution/index.ts:615 — remove the `has('strategy_3b')` register block (keep :612 `strategy_3a`)
- src/execution/strategies/strategy_3.ts:14 — the rule maps `variant 'B' → 'strategy_3b'`; drop the `'B'` path, keep `'A' → 'strategy_3a'` (callers must pass only `variant: 'A'`)
- src/execution/strategies/types.ts:10 (union `'strategy_3b'`), :97 (config interface `id: 'strategy_3b'`)
- src/execution/config/schema.ts:111 (zod `z.literal('strategy_3b')` arm), :220 (`strategy_3b` risk entry), :346-349 (the `has3a && has3b` mutual-exclusion refine — remove the `3b` half; the `has3a` reference in the LONG-vs-SHORT guard at :353 `hasShort = has3a || has3b` collapses to `has3a`), :398 (`tpVariant: 'B'` mapping for `strategy_3b`)
- src/execution/fleet/schema.ts:9 — drop `'strategy_3b'` from `StrategyNameEnum`

Edit (tests / scripts):

- src/execution/strategies/strategy_3.test.ts:56 (`id: 'strategy_3b'` fixture), :192 (`variant: 'B'`), :211 (`not strategy_3b` case) — remove `3b`-specific tests
- src/execution/strategies/registry.test.ts:6 — narrow the `makeRule` id union to drop `'strategy_3b'`
- src/backtesting/**tests**/e2e/strategy-3.e2e.test.ts:187,:231 — remove the two `Strategy3('strategy_3b')` cases
- src/backtesting/**tests**/config-loader.test.ts:178-187 (`3b` deadline accept/reject tests), :212 (`'strategy_3b'` VALID-list assertion)
- src/execution/scripts/live-strategy-3.ts:14 (doc), :160 (`s.id === 'strategy_3a' || s.id === 'strategy_3b'` → drop the `3b` disjunct)
- src/execution/scripts/live-e2e-test-multi.ts:381 (`strategy_3b:` risk block — remove; keep :380 `strategy_3a`)
- config/execution.dry-run.yaml:33 (`#- id: strategy_3b`), :55 (`strategy_3b:` risk); config/execution.live.yaml:38, :61 — remove the commented `3b` lines and the mutual-exclusion comments (:21 / :25) that reference it

## The change (numbered)

1. Delete the 6 `strategy_3b-*.yaml` live-configs and the backtest `strategy_3b.yaml`.
2. Backtesting: drop the `3b` registry/loader cases, narrow the `strategy-3.ts` ctor + `Strategy3Config` id, and remove the VALID_STRATEGY_IDS entry.
3. Execution: drop the `has('strategy_3b')` register block, remove the `'B'` variant path in `strategy_3.ts`, the union member + config type, the zod literal arm, the risk entry, the `tpVariant 'B'` mapping, and the fleet enum value.
4. Rework the exec schema refine: remove the `3a`/`3b` mutual-exclusion (now vacuous with a single SHORT rule) and simplify `hasShort` to `has3a` — **the LONG-vs-SHORT co-run guard (§11.1) stays and still fires on `strategy_3a`**.
5. Update tests, the two live-strategy-3 / live-e2e scripts, and the commented exec YAML lines.

## Verification

- `npm run build` typechecks; `strategy_3a` exec + backtest paths compile unchanged.
- `npm test` green; `strategy-3.e2e.test.ts` `3a` cases + `strategy_3.test.ts` `3a`/variant-`A` cases pass.
- `npm run config:validate` passes; the S3a-vs-LONG co-run guard still rejects a config that enables both `strategy_3a` and any LONG rule (globals §11.1).
- `grep -rn "strategy_3b" src config live-configs autoresearch` returns zero non-historical hits.

## Notes / blockers

- Blocker order: delete the 6 live-configs before removing the `StrategyNameEnum` value or `config:validate` fails on existing fleet configs.
- Do NOT remove or weaken the LONG-vs-SHORT co-run guard at execution/config/schema.ts:351-363 — only its `has3b` term collapses. Confirm the guard still keys off `has3a` after the edit.
- `strategy-3.ts` / `strategy_3.ts` files are kept (canonical `3a` lives there) — variant-strip only.
