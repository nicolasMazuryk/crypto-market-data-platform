---

# Task 25 — REST funding-fee income adapter gap (gateio/bybit/kucoin/bitget)

**Phase:** 5 — Live-only concerns · **Priority:** P2 · **Parity:** live
**Deps:** 22 · **Closes:** F6 follow-up (adapter-capability gap) · **Spec:** `00_globals.md §8` (REST funding-fee poll for WS-gated strategies)

## Goal

Task 22 ratified `createFundingIncomePoller` (`src/execution/funding/funding-income-poller.ts`) as
the §8 realization of the REST funding-fee poll, and proved (via test) that it opens both the S2
tracker gate and the S6 entry gate on `bus.emit('ws.funding_fee', ...)`. But the poller only works on
venues whose REST adapter implements `fetchFundingFeeIncome` — today that's **binance + okx only**.
The other four supported venues (gateio, bybit, kucoin, bitget) lack the method entirely, so any
WS-gated strategy (S1-WS, S2, S6) running on those venues has **no REST fallback** if the WS
`FUNDING_FEE` event is missed — it relies solely on the hard timeout path
(`funding_event_timeout` / tracker's own deadline), not the intended poll-and-recover behavior.

## Spec anchors

- `00_globals.md §8` — REST funding-fee poll at `T_settle + 3 s`, retries to grace, for **all**
  WS-gated strategies, implicitly all venues (no venue carve-out stated in spec).
- `07_strategy_6.md §2` — funding-fee attribution table assumes settled fee is observable per venue.

## Files to read

- `src/execution/adapters/rest/types.ts:111` — `fetchFundingFeeIncome?(symbol, fundingTs): Promise<FundingIncomeRecord | null>` (optional on `ExchangeRestAdapter`).
- `src/execution/adapters/rest/binance.ts:48-73` — reference impl via `fapiPrivateGetIncome` (`incomeType: 'FUNDING_FEE'`).
- `src/execution/adapters/rest/okx.ts:42-` — reference impl via `ccxtEx.fetchFundingHistory`.
- `src/execution/adapters/rest/ccxt-base.ts:51,627` — `CcxtAdapterSpec.buildExtras?(ccxtEx)` hook; merged into the adapter at `:627`. gateio/bybit/kucoin/bitget specs currently have **no** `buildExtras`.
- `src/execution/adapters/rest/gateio.ts`, `bybit.ts`, `kucoin.ts`, `bitget.ts` — target files, one `buildExtras` block each.
- `src/execution/funding/funding-income-poller.ts` — consumer; calls `rest.fetchFundingFeeIncome?.(...)` per open intent, already handles the `undefined`/missing-method case (skips silently) — confirm this stays correct once all six venues implement it.
- `src/execution/adapters/rest/binance.test.ts`, `okx.test.ts` — existing per-adapter unit test pattern for `fetchFundingFeeIncome`.

## Files to edit

- `src/execution/adapters/rest/gateio.ts` — add `buildExtras` → `fetchFundingFeeIncome`.
- `src/execution/adapters/rest/bybit.ts` — add `buildExtras` → `fetchFundingFeeIncome`.
- `src/execution/adapters/rest/kucoin.ts` — add `buildExtras` → `fetchFundingFeeIncome`.
- `src/execution/adapters/rest/bitget.ts` — add `buildExtras` → `fetchFundingFeeIncome`.
- New/extended test files per adapter (`gateio.test.ts`, `bybit.test.ts`, `kucoin.test.ts`, `bitget.test.ts`), or `adapters/rest/__tests__/conformance.ts` if the fixture supports optional-method conformance checks.

## The change (numbered)

1. **Per-venue funding-income API research.** For each of gateio, bybit, kucoin, bitget, identify the
   CCXT-exposed (or raw REST-via-CCXT `xxxPrivateGetYyy`) endpoint that returns realized funding-fee
   income for a symbol in a time window — mirroring Binance's `fapiPrivateGetIncome` /
   `incomeType=FUNDING_FEE` or OKX's `fetchFundingHistory`. Confirm CCXT unified `fetchFundingHistory`
   coverage per exchange first (cheapest option, same as OKX) before falling back to a raw
   exchange-specific endpoint.
2. **Implement `fetchFundingFeeIncome` via `buildExtras`.** For each adapter, add a `buildExtras`
   returning `{ async fetchFundingFeeIncome(symbol, fundingTs) { ... } }` matching the
   `FundingIncomeRecord | null` return shape (`symbol`, `fundingTime`, `fundingAmount`, `asset`) and the
   existing lookup-window convention (`fundingTs - 10_000` .. `fundingTs + 60_000`, match on
   funding-fee-type row, `null` if none found).
3. **Symbol resolution.** Reuse the OKX pattern (`normalizeSymbol` + `ccxtEx.markets` lookup) rather
   than assuming the raw `symbol` param is already exchange-native — each venue's raw symbol format
   differs (see repo's symbol-normalization table in `CLAUDE.md`).
4. **No poller change expected.** `funding-income-poller.ts` already treats `fetchFundingFeeIncome` as
   optional and per-adapter; once all six adapters implement it, coverage becomes universal with zero
   changes to the poller itself. Confirm this by inspection, don't refactor speculatively.

## Verification

- Unit (one per adapter): `fetchFundingFeeIncome` returns a matching `FundingIncomeRecord` for a mocked
  funding-fee row within the lookup window, and `null` when no matching row exists — mirroring
  `binance.test.ts` / `okx.test.ts` structure.
- Unit/integration: `createFundingIncomePoller` fires `ws.funding_fee` for an intent on each of the four
  newly-covered venues (extend the Task 22 S2/S6 poller-coverage tests to loop over
  gateio/bybit/kucoin/bitget instead of only asserting binance/okx).
- Run `npm test` + `npm run typecheck`; lint scoped to changed adapter/test files.

## Notes / blockers / open questions

- Depends on Task 22 (poller ratified as the §8 mechanism; this task only closes the adapter-capability
  gap it explicitly flagged as out of scope).
- Each venue's raw funding-income endpoint needs confirming against live CCXT version in use — if CCXT's
  unified `fetchFundingHistory` doesn't cover a venue, fall back to the venue's raw private endpoint
  (same shape as Binance's `fapiPrivateGetIncome` escape hatch) and note the CCXT gap for future upgrade.
- No spec anchor mandates per-venue implementation order; do all four together since the fix pattern
  (`buildExtras` + one test) is identical, not sequential.
