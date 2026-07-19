---
# Task 12 — Latency & fill model

**Phase:** 3 — Parity-critical core model · **Priority:** P0 · **Parity:** bt
**Deps:** 05, 06 · **Closes:** B1, B2, B4, B5, B6, B7, C9, L1, S3a · **Spec:** §4, §5.1
---

## Goal

Implement the §4 latency & fill model so every simulated order pays realistic
costs: a one-candle latency between decision and fill, market slippage on every
market/stop fill, honest gap-through stops, reduce-only qty caps, and lot-step /
minCost feasibility. This gates all backtest strategy work (Tasks 16–20).

## Spec anchors

- §4 — order placement latency (`order_latency_ms = 1000`, one candle, on entries/exits/cancels/re-places); market fill = touch ± `market_slippage_pct`; stop-market gap-through fills at next-available price ± slippage, never the trigger; reduce-only qty cap; lot/notional feasibility.
- §5.1 — accrual is tested against **fill time including injected latency** (this task supplies the fill time Task 13 consumes).
- §10.2 — `market_slippage_pct` (0.05) and `order_latency_ms` (1000) are backtest-only keys.
- §14 — conservatism: latency, slippage-on-every-fill, worst gap-through fills.

## Files to read

- `src/backtesting/orders/market-order.ts` — `fillMarketOrder` (returns `ask_open`/`bid_open`, no slippage).
- `src/backtesting/orders/stop-order.ts` — `checkStopFill` (always fills `stopPrice·(1±slippage)`, no gap-through).
- `src/backtesting/orders/limit-order.ts` — `checkLimitFill` (strict trade-through, lines 21/33 — **already correct, do not touch**).
- `src/backtesting/orders/simulator.ts` — `simulateOrders` / `simulateLadderOrders`.
- `src/backtesting/orders/types.ts` — `Order` / `Fill`.
- `src/backtesting/strategies/strategy-1.ts:32` (`void slippage`), `:46-49` (entry fills on decision candle).
- `src/backtesting/config/schema.ts` (`SlippageConfig`, line 48-52 — only `stop_order_slippage` exists).
- `src/backtesting/__tests__/market-order.test.ts`, `stop-order.test.ts`, `limit-order.test.ts`, `simulator.test.ts`.

## Files to edit

- `src/backtesting/orders/market-order.ts` — add slippage to touch fill.
- `src/backtesting/orders/stop-order.ts` — gap-through worst-price fill.
- `src/backtesting/orders/simulator.ts` — reduce-only cap + lot/minCost feasibility.
- New helper for latency (decision-ts → fill-ts = +1 candle) consumed by strategies.
- `src/backtesting/config/schema.ts`, `config/loader.ts` — add `market_slippage_pct` (0.05) and `order_latency_ms` (1000).
- `src/backtesting/strategies/strategy-1.ts` (and, later, all bt strategies) — apply latency between decision and fill.

## The change (numbered)

1. **Inject `order_latency_ms = 1000` between every decision and fill.** Today the entry decision candle _is_ the fill candle: strategy-1.ts:46-49 reads `entryCandle = getRowAt(entryTs)` and fills at `entryTs`. Introduce a latency shift so a decision at candle `t` fills at candle `t+1` (one candle), applied to entries, exits, cancels, and re-places. Expose the effective fill timestamp so Task 13 can run the §5.1 accrual test against it.
2. **Market slippage on every market/stop fill.** `fillMarketOrder` (market-order.ts:10-30) returns `ask_open` (buy) / `bid_open` (sell) with no slippage; strategy-1.ts:32 discards it (`void slippage`). Apply `market_slippage_pct` adversely: buys fill at `touch·(1 + s)`, sells at `touch·(1 − s)`. Add `market_slippage_pct` config; keep the existing `stop_order_slippage` distinct or fold per §4 (document choice).
3. **Stop gap-through.** stop-order.ts:23,37 always fills at `stopPrice·(1±slippage)`. When the candle path gapped _through_ the stop (opened beyond it), fill at the worse next-available price ± slippage, never at the trigger level (§4 stop-market row).
4. **Reduce-only qty cap.** Reduce-only exits must not open opposite exposure on a race; cap simulated qty at the current position size (§4). Enforce in `simulateOrders` / the exit path.
5. **Lot-step floor + minCost feasibility.** On every simulated order, floor qty to the exchange lot step and check `minCost`; drop/skip infeasible orders exactly as live (§4, §G-R for ladders).
6. **Do NOT touch limit trade-through** (limit-order.ts:21/33) — strict `<`/`>` is already correct and is a primary over-optimism guard.

## Verification

- Unit tests: an entry decision at candle `t` fills at candle `t+1`; a market buy fills at `touch·(1+s)` and sell at `touch·(1−s)`; a stop whose candle gaps through fills worse than the trigger; a reduce-only order is capped to position size; an order below lot-step/minCost is skipped.
- Confirm limit-order tests are unchanged.
- `npm test`, `npm run lint`.

## Notes / blockers / open questions

- This is the gate for Tasks 16–20 — land it first among the strategy-facing work.
- Latency + fill-time output is the input contract for Task 13 (accrual) and Task 14 (same-candle rules); coordinate the fill-timestamp shape.
- Exchange lot-step / minCost metadata source: reuse `config/exchanges.ts` if present, else stub with a documented default and flag as open.
