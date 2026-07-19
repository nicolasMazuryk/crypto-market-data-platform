---

# Task 22 — Live per-exchange deltas & engine guards batch

**Phase:** 5 — Live-only concerns · **Priority:** P2 · **Parity:** live
**Deps:** 05, 09 · **Closes:** F3, F4, F6, F7, F8, G2, G3, R9 · **Spec:** 00_globals.md §8 (order path & per-exchange deltas), §9 (guards)

## Goal

Land a batch of small live-only guard/delta fixes so the engine matches `00_globals.md §8`/§9
exactly: submission stagger defaults, rate-limit reservation ratification, REST funding-fee poll
coverage, S2 tracker ±5 s window, stale-snapshot age, S6 candidate ordering, and per-exchange config
deltas. Each item is independently testable.

## Spec anchors

- `00_globals.md §8`: submission stagger (Bybit 150 ms, Binance 100 ms, **others 100 ms default**);
  rate-limit reservation = 10% of budget for submit/cancel; REST funding-fee poll for WS-gated
  strategies at `T_settle + 3 s`, 8 s grace; funding-fee match tolerance ±5 s; per-exchange deltas
  (OKX `fundingFeeTimeoutSeconds = 45`, OKX `leverage = 4` on strategy_1).
- `00_globals.md §9`: skip snapshots older than 60 s; order candidates most-negative-first,
  **most-extreme-first for S6 positive thresholds**.

## Files to read

- `src/execution/execution/manager.ts:165-187` (`withSubmissionGate`, `staggerMs ?? 0` at 166-167).
- `src/execution/index.ts:543` (`submissionStaggerMs: { bybit: 150, binance: 100 }`).
- `src/execution/core/ratelimit/tokenBucket.ts:230-250` (`reserve()`); `src/execution/core/types.ts:133` (iface).
- `src/execution/adapters/rest/ccxt-base.ts:413` (`createOrder` → `'critical'`), `:505` (`cancelOrder` → `'normal'`).
- `src/execution/execution/monitor.ts:236,240` (`REST_POLL_DELAY_MS=3000`, `REST_POLL_GRACE_MS=8000`).
- `src/execution/index.ts:438-457` (`restFundingFeePoller`, Binance-only).
- `src/execution/execution/manager.ts:1171-1185` (S2 tracker WS gate), `:3082-3100` (S6 WS gate).
- `src/execution/execution/scheduler.ts:100` (`staleMaxAgeMs ?? 30_000`), `:121` (`.sort((a,b)=>a.fundingRate-b.fundingRate)`).

## Files to edit

- `src/execution/index.ts` (stagger config; stale-snapshot override; poller wiring/venues).
- `src/execution/execution/manager.ts` (S2 upper-bound gate; S6 poll gate wiring).
- `src/execution/execution/scheduler.ts` (S6 descending sort; stale age default).
- `src/execution/core/ratelimit/tokenBucket.ts` + callers OR `ccxt-base.ts` (F4 — see OQ-2).

## The change (numbered)

1. **F3 — submission stagger default.** `withSubmissionGate` uses `opts.submissionStaggerMs?.[exchange] ?? 0`
   (`manager.ts:166`) and config only supplies `{ bybit: 150, binance: 100 }` (`index.ts:543`) — so
   okx/gateio/kucoin/bitget get 0 ms. Add `100` for those four venues (per §8 "others 100 ms default").
2. **F4 / OQ-2 — rate-limit reservation.** `tokenBucket.reserve()` (`tokenBucket.ts:230`) has **zero
   production callers** (only the `core/types.ts:133` interface + `tokenBucket.test.ts`); the realized
   design is priority classes instead (`createOrder='critical'` `ccxt-base.ts:413`, `cancelOrder='normal'`
   `ccxt-base.ts:505`). **OQ-2, pick one:** (a) wire an explicit 10% reservation via `reserve()` on the
   `order_write` bucket to literally match §8; or (b) ratify the priority-class scheme as the §8
   realization AND privilege `cancelOrder` to `'critical'` (cancels are protective, must not queue behind
   normal traffic). State both options in the task; recommend (b) + spec amendment.
3. **F6 / OQ-6 — REST funding-fee poll coverage.** The poller is wired only for the S1-WS monitor and only
   Binance (`monitor.ts:236,240`; builder `index.ts:438-457`). Extend the funding-gate poll to the S2
   tracker gate (`manager.ts:1171-1185`) and the S6 entry gate (`manager.ts:3082-3100`), and to all venues
   (generalize the Binance-only `restFundingFeePoller` in `index.ts` — OQ-6: which venues actually omit the
   WS FUNDING_FEE event; default to polling all WS-gated strategies).
4. **F7 — S2 tracker ±5 s upper bound.** `manager.ts:1176` checks only the lower bound
   (`event.fundingTime < fundingTs - toleranceMs`). Add the upper bound
   (`|| event.fundingTime > fundingTs + toleranceMs`), matching the S6 gate at `manager.ts:3086`.
5. **G2 — stale snapshot 60 s.** `scheduler.ts:100` uses `opts.staleSnapshotMaxAgeMs ?? 30_000` and
   `index.ts` passes no override, giving 30 s. §9 mandates 60 s — set `60_000` (via the index override
   or by changing the default).
6. **G3 — S6 candidate ordering.** `scheduler.ts:121` always sorts ascending by `fundingRate`
   (most-negative-first). For S6 positive thresholds this is backwards; sort **descending by `|F|`**
   (most-extreme-first) when the enabled strategy set is S6/positive-threshold. §9 requires most-extreme-first.
7. **F8 / R9 — per-exchange deltas.** OKX `fundingFeeTimeoutSeconds = 45` and OKX `leverage = 4` (S1) must
   flow via per-exchange YAML override, not hardcode. Verify the canonical schema (Task 05) supports a
   per-exchange override for these keys; confirm the engine has **no** hardcoded delta (it should read from
   config). No engine change if the schema already carries it — this is a verification item.

## Verification

- Unit: stagger returns 100 ms for okx/gateio/kucoin/bitget; 150/100 for bybit/binance.
- Unit: S2 tracker rejects a `ws.funding_fee` event with `fundingTime > fundingTs + 5000` (upper bound).
- Unit: scheduler treats a 45 s-old snapshot as fresh and a 61 s-old snapshot as stale (60 s boundary).
- Unit: S6 candidate list orders most-extreme-|F|-first for a positive threshold.
- Unit/integration: REST funding-fee poll fires for an S2 and an S6 intent (not just S1-WS/Binance).
- Config: OKX profile yields `fundingFeeTimeoutSeconds = 45`, `leverage = 4` (S1) with no hardcoded fallback.

## Notes / blockers / open questions

- OQ-2 (F4): reservation vs priority-class — recommend ratifying priority classes + promoting cancelOrder to critical.
- OQ-6 (F6): confirm per-venue which push FUNDING_FEE over WS vs need REST poll; today only Binance is special-cased.
- Depends on Task 05 (canonical schema) for the per-exchange override surface (item 7) and Task 09 (S6 gate) for item 3.
