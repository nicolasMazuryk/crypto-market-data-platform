---
# Task 14 — Same-candle resolution rules

**Phase:** 3 — Parity-critical core model · **Priority:** P1 · **Parity:** bt
**Deps:** 11, 12 · **Closes:** C5, C6, C8 · **Spec:** §5.5, §3.2
---

## Goal

Implement the §5.5 intra-candle realism rules completely. Today the SL-exception
(rule 1), entry-vs-SL worst-case (rule 4), and credit-gated `drop_candle+1`
gating (rule 2) are missing or only loosely approximated; SL-first (rule 3) is
already correct and must be kept.

## Spec anchors

- §5.5 rule 1 — no same-candle round trips **except SL**: an SL may fire on the entry-fill candle; every other exit (TP, retracement, timed, deadline) starts at `entry_candle + 1`.
- §5.5 rule 2 — credit-gated actions execute no earlier than `drop_candle + 1`.
- §5.5 rule 3 — SL-vs-TP conflict resolves SL-first (pessimistic). Already implemented; keep.
- §5.5 rule 4 — entry-vs-protective-order in one candle: both fire, outcome is worst (entry filled + SL exits same candle at stop/gap-through).
- §5.5 rule 5 — gap-through fills: handled in Task 12.
- §3.2 — no strategy logic on `drop_candle` prices.

## Files to read

- `src/backtesting/orders/simulator.ts:63-92` — SL-first resolution (rule 3, already correct — keep).
- `src/backtesting/strategies/strategy-2.ts:79-114` — post-entry loop starts at `entry+1` (SL wrongly excluded from entry candle).
- `src/backtesting/strategies/strategy-3.ts:68-77` — `orderCandles = postEntryRows.slice(1)` (SL also starts entry+1).
- `src/backtesting/strategies/strategy-4-2.ts:75, 89` — SL placed only from `entryIdx+1` (`postEntryRows = windowRows.slice(entryIdx+1)`, `validFrom: firstPostRow.ts`).
- `src/backtesting/strategies/strategy-4-1.ts:104-135` — per-rung SL/TP lifecycle (`postFillRows.slice(1)`).
- `src/backtesting/orders/types.ts` (`Order.validFrom`), Task 11 output (`drop_candle` timestamp), Task 12 output (fill timestamps).
- `src/backtesting/__tests__/simulator.test.ts`, `stop-order.test.ts`.

## Files to edit

- `src/backtesting/orders/simulator.ts` — allow SL on the entry-fill candle; entry-vs-SL worst-case path.
- `src/backtesting/strategies/strategy-2.ts`, `strategy-3.ts`, `strategy-4-1.ts`, `strategy-4-2.ts` — SL `validFrom` = entry-fill candle; non-SL exits from `entry_candle+1`; credit-gated actions from `drop_candle+1`.
- Tests: `simulator.test.ts`, per-strategy e2e fixtures.

## The change (numbered)

1. **Rule 1 — SL-exception.** Today the SL starts at `entry_candle + 1`: strategy-2.ts:79-80 evaluates from `entryPlus1Ts`; strategy-3.ts:71 drops the entry candle for _all_ orders via `orderCandles.slice(1)`; strategy-4-2.ts:75/89 places the SL only from `entryIdx+1`. Change so the **SL may fire on the entry-fill candle** while TP/retracement/timed/deadline still evaluate from `entry_candle + 1`. This recovers entry-candle stop-outs currently missed.
2. **Rule 4 — entry-vs-SL both fire, worst outcome.** When a limit entry and its SL level are both inside one candle's range (strategy-4-2.ts, and any limit-entry strategy), model **both firing on that candle**: entry filled, SL exits same candle at the stop (or worse gap-through with slippage from Task 12). Add this worst-case path in `simulateOrders` / the entry+SL handoff.
3. **Rule 2 — credit-gated ≥ `drop_candle + 1`.** Enforce structurally, not by an approximate buffer. S2 currently only loosely approximates this via `tp_post_settlement_buffer_seconds` and `activeTpFrom` (strategy-2.ts:105-113). Gate any credit-gated action (S2 TP tracker arming; where relevant, per-rung protective orders on `drop_candle` for S4) to start at `drop_candle + 1` using the Task-11 localized `drop_candle` timestamp.
4. **Rule 3 — keep SL-first.** simulator.ts:67-76 already resolves an SL+TP same-candle collision as SL-first for both directions. Do not regress it; extend the same worst-ordering principle to any new competing-order pair introduced by rule 4.
5. **Rule 5 — gap-through** is Task 12; here only ensure the entry-candle SL path routes through the gap-through fill.

## Verification

- Unit tests: a candle spanning entry + SL fires **both** at the worst price (entry filled, SL exits same candle); a candle spanning SL + TP resolves SL-first; a credit-gated action never executes on `drop_candle` (only `drop_candle+1` onward); a non-SL exit never executes on the entry-fill candle.
- Per-strategy e2e: entry-candle stop-outs now appear where previously missed.
- `npm test`, `npm run lint`.

## Notes / blockers / open questions

- Depends on Task 11 (`drop_candle` timestamp) and Task 12 (gap-through fill + fill timestamps).
- S4.1a per-rung lifecycle (§G-R, R11) is fully specified in `05_strategy_4_1a.md` §2 — coordinate rung-level `drop_candle+1` gating with Task 05 rather than duplicating it here.
- Keep the pessimistic direction everywhere (§14): any ambiguous ordering resolves against the strategy.
