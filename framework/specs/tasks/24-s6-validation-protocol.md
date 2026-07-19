---
# Task 24 — S6 substitute validation protocol (shadow → canary)

**Phase:** 5 — Live-only concerns · **Priority:** P3 · **Parity:** live
**Deps:** 09 · **Closes:** S6 validation, S6 nuance · **Spec:** 07_strategy_6.md §6.1 (not backtestable), §6.2 (substitute protocol), §2 (settled |F| at fill)

## Goal
S6 is not backtestable (`07_strategy_6.md §6.1`; the backtest registry throws — conforms). Scaffold the
`§6.2` substitute validation protocol — a **shadow phase** then a **canary phase** with pre-registered
acceptance metrics — so S6 can be validated live-empirically instead of by simulation. Optionally fix
the settled-|F| nuance: TP/SL should use the **settled** rate re-fetched at MAIN fill, not the
selection-time rate carried on the intent.

## Spec anchors
- `07_strategy_6.md §6.1` — two blockers (causal gating on a private WS event; fill inside the forbidden
  `drop_candle` §5.5.2) ⇒ not backtested at all.
- `07_strategy_6.md §6.2` — shadow (≥2 wk, order submit stubbed at adapter, log-only) + canary (≥4 wk,
  min sizing, one symbol cohort/venue) with acceptance metrics (a)–(e); ongoing per-trade event-timeline logging.
- `07_strategy_6.md §2` step 4 — "tpPct/slPct are computed at FILL time from the settled |F|, not at decision time".
- `00_globals.md §12.2` — S6 error-code taxonomy (`funding_event_timeout`, `close_pre_funding_failed`, …).

## Files to read
- `src/backtesting/strategies/registry.ts:15-17` — `strategy_6` throws in backtest (conforms; do not change).
- `src/execution/execution/manager.ts:2833-3170` — S6 live state machine (PRE_FUNDING → WS gate → MAIN → exit).
- `src/execution/execution/manager.ts:3082-3100` — S6 `ws.funding_fee` gate + timeout → `funding_event_timeout`.
- `src/execution/execution/manager.ts:813` — `const absF = Math.abs(intent.fundingRatePercent)` (selection-time),
  `:837-841` — TP/SL computed from `absF` at MAIN fill. **This is the nuance:** it uses the intent's
  selection-time rate, not a settled rate re-fetched at fill.

## Files to edit
- New harness/docs under `src/execution/**` for the shadow phase (adapter-level order-submission stub +
  event-timeline logging). Prefer extending existing S6 logging over new files where possible.
- `src/execution/execution/manager.ts:813,837-841` — optional nuance fix (re-fetch settled |F| at fill).
- Acceptance-metric definitions (config or docs) with pre-registered thresholds.

## The change (numbered)
1. **Shadow harness (≥2 weeks, all venues).** Run the full S6 state machine (`manager.ts:2833-3170`) with
   order submission **stubbed at the adapter** (log-only, no real orders). Capture per venue:
   (i) `ws.funding_fee` arrival rate; (ii) `T_event − T_settle` latency distribution;
   (iii) would-be MAIN decision/fill timestamps; (iv) selection frequency at the configured threshold.
2. **Canary phase (≥4 weeks, min sizing, one symbol cohort per venue).** Pre-register acceptance
   thresholds, checked **before** scale-up:
   (a) `funding_event_timeout` rate ≤ 2× the shadow-phase miss estimate;
   (b) MAIN slippage p90 ≤ 2× the assumed `market_slippage_pct`;
   (c) realized PRE overhead (`|PRE_FUNDING_DELTA| + |FUNDING_PRE| + PRE fees`) in bp of net notional;
   (d) funding-attribution audit per venue vs income statements (fills the §2 attribution table);
   (e) **zero** `close_pre_funding_failed` occurrences, else halt.
3. **Ongoing per-trade event-timeline logging.** Every S6 trade logs `T_settle`, event-receive time,
   MAIN send/fill times, and post-hoc drop-candle stats so the live dataset becomes the calibration set
   for any future simulation attempt.
4. **Optional nuance — settled |F| at fill.** Spec §2 requires tpPct/slPct from the **settled** |F| at
   MAIN fill; the engine uses `intent.fundingRatePercent` (selection-time) at `manager.ts:813`. Re-fetch
   the settled rate at fill (alongside the existing REST `getPositions()` net-qty confirm) and feed it to
   `manager.ts:837-841`. The live state machine otherwise already conforms — do not restructure it.

## Verification
- Shadow harness produces the per-venue latency + timeout dataset with zero real orders submitted
  (adapter stub asserted).
- Canary acceptance thresholds (a)–(e) are documented and evaluated as gates before scale-up; a run
  breaching (e) halts.
- Nuance test (if implemented): TP/SL prices derive from the settled rate observed at MAIN fill, not the
  selection-time `intent.fundingRatePercent`.
- Backtest still throws for `strategy_6` (`registry.ts:15-17` unchanged).

## Notes / blockers / open questions
- Depends on Task 09 (S6 live state machine) being in place.
- Nuance (item 4) is optional and small; it is the only S6 spec-vs-engine divergence found and can ship
  independently of the shadow/canary scaffolding.
- Per-venue funding-attribution table (`07_strategy_6.md §2`) is completed by canary metric (d), not upfront.
