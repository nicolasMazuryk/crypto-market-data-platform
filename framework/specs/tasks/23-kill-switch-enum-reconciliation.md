---

# Task 23 — Kill-switch enum reconciliation (spec ↔ engine)

**Phase:** 5 — Live-only concerns · **Priority:** P2 · **Parity:** live
**Deps:** 10 · **Closes:** E1, OQ-3 · **Spec:** 00_globals.md §7.1 (kill switch), §12.1 (`kill_switch_flatten`)

## Goal

Reconcile the kill-switch model: `00_globals.md §7.1` names states `off | paused | flatten`, but the
engine uses a richer mode enum `live | dry_run | drain_only | halted` with `flatten` as a **CLI /
shutdown action** (`flattenAll()` reduce-only closes), not a preflight mode. The reject-before-API
behavior and the `kill_switch` error code already conform. Recommendation (OQ-3): treat the **code
model as authoritative**, amend the spec, document the mapping, and do **not** churn the engine. Also
align the `kill_switch_flatten` exit_reason string introduced by Task 10.

## Spec anchors

- `00_globals.md §7.1`: states `off | paused | flatten`; when `!= off`, `preflight()` rejects every new
  intent with `intent.error { code: 'kill_switch' }` before any exchange API call; `flatten` additionally
  runs `flattenAll()` (reduce-only market closes).
- `00_globals.md §12.1`: `kill_switch_flatten` exit_reason — "Flattened by kill switch — any (live only)".

## Files to read

- `src/execution/risk/types.ts:4` — `export type EngineMode = 'live' | 'dry_run' | 'drain_only' | 'halted'`
  (`KillSwitchState` interface begins line 12).
- `src/execution/execution/preflight.ts:32-38` — reject-before-API: `killSwitch.canPlaceOrder(...)` →
  `{ ok: false, code: 'kill_switch', message: 'kill switch: mode=...' }`.
- `src/execution/index.ts:561` — `killSwitch.wireFlattener(() => execManager.flattenAll())` (trip/halt does
  not itself flatten); `:752` — shutdown path calls `execManager.flattenAll()`.
- `src/execution/cli/flatten.ts` — emergency flatten CLI: cancels open orders + reduce-only closes all
  positions across exchanges, runs even when the engine process is dead (REST adapters directly).
- Task 10 deliverable — `kill_switch_flatten` exit_reason wiring.

## Files to edit

- `docs-strategy/strategies/00_globals.md §7.1` — amend the enum + add the mapping table (primary edit).
- Wherever Task 10 emits the flatten exit_reason — ensure the exact string `kill_switch_flatten`
  (engine constant matches §12.1). No change to `risk/types.ts` mode enum.

## The change (numbered)

1. **Amend spec §7.1** to make the code model authoritative: replace `off | paused | flatten` with the
   engine's `EngineMode = live | dry_run | drain_only | halted` (`risk/types.ts:4`), and document that
   "flatten" is an **action** (CLI `cli/flatten.ts` / shutdown `index.ts:752` / `killSwitch.wireFlattener`
   `index.ts:561`), not a mode.
2. **Add a mapping table** to §7.1 documenting the spec-name → engine-concept correspondence:
   `off → live`; `paused → halted` (rejects new intents in preflight, no exchange activity);
   `flatten → CLI flattenAll` (reduce-only closes, a discrete action). Note `dry_run`/`drain_only` are
   engine modes with no spec-name counterpart (document them).
3. **Confirm, do not change,** that `preflight.ts:32-38` still rejects with `code: 'kill_switch'` before
   any exchange API call — this already conforms to §7.1 and §12.2.
4. **Align exit_reason** (from Task 10): the kill-switch flatten path emits exit_reason exactly
   `kill_switch_flatten` per §12.1. Ensure the engine constant/string matches the spec verbatim.
5. This task is **spec-amendment + mapping-doc + the exit_reason string** — no engine mode-enum churn.

## Verification

- Spec §7.1 shows the four-mode enum + the paused→halted / flatten→CLI-flattenAll mapping table.
- Preflight test: with kill switch engaged, a new intent is rejected with `code: 'kill_switch'` and
  no exchange API call (`preflight.ts:32-38` unchanged).
- Flatten CLI test: `cli/flatten.ts` still cancels orders + places reduce-only market closes across venues.
- Exit-reason test: a kill-switch-driven flatten produces exit_reason `kill_switch_flatten` (Task 10).

## Notes / blockers / open questions

- OQ-3 recommendation: adopt the richer code model as authoritative; the spec's three-state model was
  the source extract's simplification. Do not add `paused`/`flatten` modes to `EngineMode`.
- Depends on Task 10 for the `kill_switch_flatten` exit_reason emission point.
