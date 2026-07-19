---
# Task 13 — Accrual boundary fix (funding tested at T_settle)

**Phase:** 3 — Parity-critical core model · **Priority:** P1 · **Parity:** bt
**Deps:** 11, 12 · **Closes:** C1, OQ-4 · **Spec:** §5.1, §5.5
---

## Goal
Funding P&L must be credited/charged iff the position is open at **`T_settle`**,
tested against the **fill time including injected latency** (§5.1). Today S1/S2
mistakenly pass `T_drop` (the localized settlement) as the accrual boundary, and
a spec-less `funding_applied_on_same_second` toggle softens the boundary. Fix the
boundary and hard-code the pessimistic §5.5 rule.

## Spec anchors
- §5.1 — accrual rule: open at `T_settle`, tested at fill-time-incl-latency, not decision time; the canonical false-positive generator is an order sent before `HH:MM:00` but filled after.
- §5.5 — same-candle pessimism: a fill landing on/after `T_settle` earns no funding while the trade still books its adverse delta.
- §1.1 — `T_settle` vs `T_drop`: never merge them.

## Files to read
- `src/backtesting/pnl/funding-applicability.ts` — `shouldApplyFunding` (right shape, wrong boundary usage at line 13).
- `src/backtesting/strategies/strategy-1.ts:68-72` — passes `fundingTs: settlement.settlementTs` (= `T_drop`).
- `src/backtesting/strategies/strategy-2.ts:131-135` — same bug (`fundingTs: settlement.settlementTs`).
- `src/backtesting/strategies/strategy-3.ts:143-148`, `strategy-4-2.ts:133-138` — S3/S4 correctly pass raw `fundingTs` (= `T_settle`); use as the correct reference.
- `src/backtesting/config/schema.ts:114-115` and the other `funding_applied_on_same_second` rows (`:132`, `:153`, `:173`, `:191`, `:213`, `:234`).
- `src/backtesting/__tests__/funding-applicability.test.ts`.
- Task 12 output: the effective fill timestamp (incl. latency).

## Files to edit
- `src/backtesting/pnl/funding-applicability.ts` — boundary = `T_settle`; test fill-time-incl-latency; remove same-second toggle.
- `src/backtesting/strategies/strategy-1.ts`, `strategy-2.ts` — pass `T_settle` (raw `event.funding_time`), not `settlement.settlementTs`.
- `src/backtesting/config/schema.ts`, `config/loader.ts` — remove `funding_applied_on_same_second` from all strategy configs.
- Any strategy still referencing the removed field.

## The change (numbered)
1. **Fix the accrual boundary for S1/S2.** strategy-1.ts:68-72 and strategy-2.ts:131-135 pass `fundingTs: settlement.settlementTs` (= `T_drop`) into `shouldApplyFunding`. Per §5.1 the accrual test is against **`T_settle`** (the nominal `HH:MM:00`), i.e. raw `event.funding_time`, not the localized drop instant. Change both to the `T_settle` boundary. (S3/S4 already do this — strategy-3.ts:147, strategy-4-2.ts:136 — so the fix aligns S1/S2 with them.)
2. **Test against fill-time-incl-latency.** `shouldApplyFunding` (funding-applicability.ts:4-15) already compares `entryTs`/`exitTs` to `fundingTs`; feed it the *filled* timestamps including the Task-12 latency shift, not the decision timestamps. A fill landing ≥ `T_settle` must credit 0.
3. **Remove `funding_applied_on_same_second` (OQ-4).** The toggle (schema.ts:114-115 for S1, and the same row on every strategy config) has no spec counterpart. Delete it from schema.ts/loader.ts and hard-code the pessimistic §5.5 rule inside `shouldApplyFunding`: an entry filled *exactly at* `T_settle` earns nothing (pessimistic), an exit filled exactly at `T_settle` still credits (position was open through the boundary) — encode the conservative direction, not a config choice. `fundingFractionForLadder` inherits the same rule.

## Verification
- Unit tests: entry filled at `T_settle − 1s` credits funding; a fill (incl. latency) landing ≥ `T_settle` credits 0 and the trade still books its delta loss; an SL fill before `T_settle` → 0.
- S1/S2 now match S3/S4 in accrual-boundary handling; add a regression test that the boundary is `event.funding_time`, not `settlement.settlementTs`.
- `npm test`, `npm run lint`.

## Notes / blockers / open questions
- **OQ-4 resolved here:** `funding_applied_on_same_second` is removed, not reinterpreted.
- Depends on Task 11 (localization no longer overloads the accrual boundary) and Task 12 (fill-time-incl-latency). Do not start before both land.
- Ladder path (`fundingFractionForLadder`, funding-applicability.ts:29-53) uses the same `shouldApplyFunding` — verify per-fill semantics still hold, but note §G-R books `FUNDING_PNL = 0` for all 4.* regardless (that blanket rule is Task 15/strategy scope, not here).
