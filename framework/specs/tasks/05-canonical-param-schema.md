# Task 05 — Single canonical parameter schema

**Phase:** 2 — Shared foundations & contracts · **Priority:** P0 · **Parity:** cfg
**Deps:** 01, 02, 03 · **Closes:** H1, H3, R1, R9, R10, OQ-7 (+ OQ-8 regeneration) · **Spec:** `00_globals.md` §10.2, §11.2.1, §13-R1/R9/R10

## Goal
Create **one** canonical parameter registry — a single source module carrying, per parameter, `{ canonical name, backtest key (snake_case), live key (camelCase), unit, sign, schema default, bounds, per-exchange overrides, which strategies use it }` — and **generate both** the backtest snake_case schema/validator and the live camelCase zod schema from it. Hand-writing either side becomes prohibited (§11.2.1). This is the P0 foundation gating every other `cfg` task (06–10) and the `both` parity tasks that assert against these contracts.

Today there is **no** shared source: backtest = hand-written TS interfaces + imperative validator (no zod); live = a separate hand-written zod `discriminatedUnion`. They are not name- or unit-compatible. Every §11.2 protection is structurally impossible until this exists.

## Spec anchors
- `00_globals.md` §10.2 (bridge table, lines 211–237) — the authoritative name/unit/sign/default map.
- §11.2.1 (line 271) — "Backtest and live schemas are generated from one canonical schema file; hand-writing one side is prohibited."
- §13-R1 (signed-percent notation), §13-R9 (timeout consolidation), §13-R10 (Group-L threshold −0.4).
- §1.2 (lines 42–47) — unit conventions (percent / fraction / seconds / signed vs absolute).

## Files to read
- `docs-strategy/strategies/00_globals.md` §10.2 (211–237), §11.1 (249–265), §11.2 (267–274), §13.
- `src/backtesting/config/schema.ts:104-250` — hand-written strategy interfaces + `ExitReason` (do not touch enum here; Task 10).
- `src/backtesting/config/loader.ts:283-438` — imperative `validateStrategyConfig` switch.
- `src/execution/config/schema.ts:79-171` — live zod `discriminatedUnion('id', …)`.
- `src/execution/strategies/types.ts` — live `StrategyConfig` TS types the zod output must satisfy.
- Each strategy file `§5` table (`01_`…`07_strategy_*.md`) for per-strategy proposed values/units.
- `framework/specs/gap-analysis.md` lines 106–120, 179–180 (central verdict + OQ-7/OQ-8).

## Files to edit
- **New:** canonical registry module (proposed `src/config/canonical-params.ts` or `src/shared/config/canonical/`) — the single source.
- **New:** two generator/derivation modules (backtest snake_case emitter; live camelCase zod emitter) OR generate types + a runtime validator table both loaders consume.
- `src/backtesting/config/loader.ts` — replace the imperative switch with consumption of the generated backtest schema.
- `src/execution/config/schema.ts` — replace the hand-written `StrategyRawSchema` union with the generated zod.
- `live-configs/strategies/strategy_4_2a-*.yaml`, `strategy_4_3a-*.yaml` — regenerate to correct live camelCase shape (OQ-8; note 4_3a is deleted by Task 02 — if 02 landed, only 4_2a remains).

## The change (numbered)
1. **Define the canonical registry.** One entry per row of §10.2 (lines 211–237). Each entry declares: canonical name, `btKey`, `liveKey`, `unit` (percent | fraction | seconds | ms | multiplier | usd | integer | enum), `sign` (signed | absolute | n/a), `default`, `bounds` (min/max/refinement — data only; enforcement is Task 06), `strategies`, and optional `perExchangeOverride`.
2. **Reconcile every §10.2 row to canonical:**
   - `negative_funding_threshold_percent` / `negativeFundingThresholdPercent` — signed percent, must be `< 0`, **default −0.4**. Live currently defaults **−0.5** for `strategy_1` (`schema.ts:83`) and `strategy_1_ws` (`schema.ts:92`) — **OQ-7 drift; canonicalize to −0.4** (S2/S4.1a/S4.2a already −0.4 at `schema.ts:101,116,134`).
   - `funding_threshold` (backtest, `schema.ts:109`) is documented as a **positive decimal** / validated via `requirePositiveNumber` (`loader.ts:296`). **R1:** restate as **signed percent** (`negative_funding_threshold_percent`); the sign-and-percent change removes a class of sign bugs. Backtest `take_profit`/`sl_mult`/`stop_loss`/`tp_multiplier` must map to canonical `take_profit_pct`/`sl_multiplier`/`stop_loss_percent`/`tp_variant_a_multiplier`/`tp_multiplier` per §10.2.
   - Timeouts: single canonical `funding_fee_timeout_seconds` (default per each strategy §5; OKX override 45 — §13-R9).
3. **Add missing sizing keys.** Backtest schema has **no** `amount_usd` / `leverage` (absent from `Strategy1Config`…`Strategy42Config`, `schema.ts:104-195`); §10.2 line 230–231 requires both (defaults 20 USD / 4). Add to canonical → both sides.
4. **Add backtest-only keys** (§10.2 lines 233–237) currently absent: `market_slippage_pct` (0.05), `order_latency_ms` (1000), `ws_event_miss_rate` (0.02), `ws_exit_extra_delay_seconds` (2), `drop_search_window_seconds` (10), `drop_qualifier_funding_mult` (0.5), `drop_qualifier_range_mult` (3.0). Only `funding_settlement.detection_window_seconds` / `tp_post_settlement_buffer_seconds` (`schema.ts:63-68`) and `slippage.stop_order_slippage` (`schema.ts:49`) exist today — reconcile / supersede these. Mark these canonical entries `backtestOnly: true` (no live emission).
5. **Per-exchange override mechanism.** Registry must express OKX deltas (§8, line 177): `funding_fee_timeout_seconds = 45` (vs 30/10) and `leverage = 4` on `strategy_1` (vs 5). Overrides are keyed `(exchange, strategyId?)` and applied after defaults, before bounds.
6. **Migrate loaders to consume the generated schema** — delete the hand-written `validateStrategyConfig` switch body (`loader.ts:283-438`) and the hand-written `StrategyRawSchema` union (`schema.ts:79-171`), replacing each with a thin adapter over the generated artifact. Live zod output must still satisfy `src/execution/strategies/types.ts`.
7. **OQ-8 regeneration.** `live-configs/strategies/strategy_4_2a-*.yaml` are in backtest snake_case (`strategy_id`, `funding_threshold`, `entry_offset_seconds`, `take_profit`, `sl_mult`) → they parse to a **zero-strategy engine** (silently never run). Regenerate to canonical live camelCase (`id`, `negativeFundingThresholdPercent`, `entryOffsetSeconds`, `takeProfitPct`, `slMultiplier`). Same for `strategy_4_3a-*` if not already deleted by Task 02.

## Verification
- A single source file exists; `src/backtesting/config/loader.ts` and `src/execution/config/schema.ts` both import from it (grep: no residual hand-written per-strategy field lists).
- One spot config (e.g. a `strategy_2` row) rendered to both schemas validates **identically** — same accepted/rejected verdict, same numeric values after parse.
- `negativeFundingThresholdPercent` default resolves to −0.4 for `strategy_1`/`strategy_1_ws`.
- Backtest configs now accept `amount_usd`/`leverage`; the 7 backtest-only keys are present.
- Regenerated `strategy_4_2a-*.yaml` parse to a **non-empty** `strategies` array under the live zod.
- `npm test` + `npm run lint` clean.

## Notes / blockers / open questions
- **Gates everything:** Tasks 06/07/08/09/10 and the parity `both` tasks (19/20) assert against this contract. Land first.
- Bounds live in the registry as **data** here; **enforcement** is Task 06. Keep the split clean — do not scatter range checks.
- `Strategy5Config` / `SpotFuturesConfig` / `strategy_*b` variants are removed by Tasks 01–04; do not port them into canonical.
- Open: exact module path + whether generation is build-time codegen or runtime table-derivation. Prefer runtime derivation (no build step) unless type-level camelCase↔snake_case inference forces codegen.
- Flag OQ-8 explicitly in the PR — the wrong-shape YAMLs were a silent live no-op; regeneration is a behavior change (S4.2a starts actually loading).
