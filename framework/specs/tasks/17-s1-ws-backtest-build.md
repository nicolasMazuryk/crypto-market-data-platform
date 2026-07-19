---
# Task 17 — S1-WS backtest: build from scratch (funding-fee-event exit)

**Phase:** 4 — Per-strategy conformance · **Priority:** P1 · **Parity:** bt
**Deps:** 11, 12, 13, 14 · **Closes:** S1-WS, C3, C6 · **Spec:** `02_strategy_1_ws.md` §6; `00_globals.md` §3, §5.3, §5.5.2, §8
---

## Goal
BUILD the S1-WS backtest — it does not exist today. There is no
`src/backtesting/strategies/strategy-1-ws.ts`; the id is absent from the registry
switch (registry.ts:19–44) and from `VALID_STRATEGY_IDS` (schema.ts:270–283). S1-WS
is S1's entry with a **funding-fee-event** exit: exit gated on the drop event, with a
WS-miss timeout fallback that must fire at a nonzero rate.

## Spec anchors
- `02_strategy_1_ws.md` §6.1 — entry as S1 (`01_strategy_1.md` §6.1); funding accrual per `00_globals.md` §5.1.
- `02_strategy_1_ws.md` §6.2 — event emulation: localize `T_drop` (§3); with prob `1 − ws_event_miss_rate` the exit decision is at `max(T_drop, T_settle) + ws_exit_extra_delay_seconds`, fill one further candle later (latency), and **never earlier than `drop_candle + 1`** (§5.5.2); `exit_reason = funding_fee_event`.
- `02_strategy_1_ws.md` §6.3 — timeout path: with prob `ws_event_miss_rate` the gate never opens → exit decision at `T_settle + funding_fee_timeout_seconds`, `exit_reason = funding_fee_timeout`; this path **must** occur at a modeled rate > 0 (a run where it never fires is rejected).
- `02_strategy_1_ws.md` §6.5 — `no_drop_localized` fallback: `T_drop = T_settle + drop_search_window_seconds` (latest arming edge).
- `02_strategy_1_ws.md` §5 — new keys: `ws_event_miss_rate` (0.02), `ws_exit_extra_delay_seconds` (2), `funding_fee_timeout_seconds` (10; OKX 45); bound 5–120 (`00_globals.md` §11.1, §8).

## Files to read
- `src/backtesting/strategies/strategy-1.ts` — entry + funding logic to reuse.
- `src/backtesting/strategies/strategy-2.ts` — nearest existing model of a multi-path exit loop over post-entry rows.
- `src/backtesting/strategies/registry.ts:13–45` — `createStrategy` switch (must add S1-WS case).
- `src/backtesting/config/schema.ts:270–285` — `VALID_STRATEGY_IDS` / `StrategyId`; strategy config types.
- `src/backtesting/data/funding-settlement.ts` — `T_drop` localizer (post-Task 11) + `no_drop_localized` flag.
- `src/backtesting/strategies/types.ts` — `BaseStrategy`, `TradeResult`.

## Files to edit
- `src/backtesting/strategies/strategy-1-ws.ts` — NEW file.
- `src/backtesting/strategies/registry.ts` — import + `case 'strategy_1_ws'`.
- `src/backtesting/config/schema.ts` — add `strategy_1_ws` to `VALID_STRATEGY_IDS`; add `Strategy1WsConfig` (entry keys as S1 + `funding_fee_timeout_seconds`, `ws_event_miss_rate`, `ws_exit_extra_delay_seconds`).
- `src/backtesting/config/loader.ts` — parse/bound the new keys (from canonical schema, Task 05).
- New unit tests + a multi-event fixture.

## The change (numbered)
1. **Register the id.** Add `'strategy_1_ws'` to `VALID_STRATEGY_IDS` (schema.ts:270–283) and a `case 'strategy_1_ws': return new Strategy1Ws()` to the registry switch (registry.ts:19–44).
2. **Entry + funding.** Reuse S1's entry: BUY MARKET at `T_settle − entry_offset_seconds`, fill at decision + 1 s at ask proxy + slippage; credit `+|F|` iff fill time `< T_settle` (`00_globals.md` §5.1).
3. **Event exit path (prob `1 − ws_event_miss_rate`).** Localize `T_drop` (§3). Exit decision at `max(T_drop, T_settle) + ws_exit_extra_delay_seconds`; fill one candle later (latency) at the bid proxy − slippage; **clamp so the fill is never before `drop_candle + 1`** (§5.5.2). `exit_reason = funding_fee_event`, taker.
4. **Timeout exit path (prob `ws_event_miss_rate`).** The gate never opens: exit decision at `T_settle + funding_fee_timeout_seconds`, fill + latency + slippage, `exit_reason = funding_fee_timeout`, taker. Draw the miss deterministically per-event (seeded, reproducible — see Task 14) so the path fires at a modeled rate > 0 across a fleet; a run in which it never fires is rejected.
5. **`no_drop_localized` fallback.** When localization fails, set `T_drop = T_settle + drop_search_window_seconds` (latest edge) and take the event path off that late `T_drop`.
6. **Same-candle discipline.** Exit never on `drop_candle`; entry↔exit round-trip on one candle impossible by construction but enforce structurally (exit evaluation starts ≥ `entry_candle + 1`).
7. **Feasibility.** Lot-step floor + `minCost` on entry qty; infeasible → skip (no intent), as S1 rule 6.
8. **Output.** Emit `exit_reason ∈ {funding_fee_event, funding_fee_timeout}` and `t_drop_offset_s` on the `TradeResult`.

## Verification
- Unit test — event path: fixture with `T_drop` at `T_settle + 4 s`, miss not drawn → exit decision at `T_drop + ws_exit_extra_delay_seconds`, fill ≥ `drop_candle + 1`, `exit_reason = funding_fee_event`.
- Unit test — timeout path: miss drawn → exit at `T_settle + funding_fee_timeout_seconds`, `exit_reason = funding_fee_timeout`.
- Multi-event fixture: over N events with `ws_event_miss_rate = 0.02`, the timeout path fires strictly > 0 times.
- Assertion: no exit ever fills on `drop_candle`.
- `no_drop_localized` fixture: exit keyed off the `T_settle + drop_search_window_seconds` edge.
- `npm test`, `npm run lint`.

## Notes / blockers / open questions
- **BLOCKER OQ-1:** confirm build-vs-drop decision from the backtest fleet — S1-WS must be a member of the backtestable set before this is built. Resolve before merging.
- Depends on Task 11 (`T_drop` localizer), Task 12 (protective/exit fill primitives if shared), Task 13 (exit-reason enum + `TradeResult` fields), Task 14 (seeded miss-rate RNG).
- New keys come from the canonical schema (Task 05); do not hand-write live YAML in the wrong shape (`00_globals.md` §11.2).
- OKX `funding_fee_timeout_seconds = 45` is an exchange delta (`00_globals.md` §8).
