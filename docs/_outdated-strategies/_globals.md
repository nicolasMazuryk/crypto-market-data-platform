# Global Strategy Definitions

This file contains the global sections extracted verbatim from
`docs-strategy/funding_rate_strategies.md`. Every per-strategy file includes
these by reference. For the full monolith, see that file.

---

## Core Hypothesis

Tokens with significantly negative funding rates (< -1%) experience sharp price drops (−0.5% to −3%) within seconds of the funding settlement event. This document formalizes strategies to exploit this inefficiency.

---

## Global Definitions & Variables

### Timing

| Variable | Description |
|---|---|
| `T_funding` | Funding settlement timestamp (every 1h, 2h, 4h, or 8h depending on market conditions) |
| `T_entry` | Entry time relative to `T_funding` (e.g., `T_funding - 5s`) |
| `T_exit` | Exit time (strategy-dependent) |
| `T_deadline` | Maximum time to hold position before forced exit |

### Market Data

| Variable | Description |
|---|---|
| `F` | Current predicted funding rate (as a positive decimal, e.g., 0.015 for −1.5%). Always expressed as absolute value in formulas; the sign context (negative) is given by the strategy selection filter |
| `P_entry` | Price at entry |
| `P_funding` | Price at exact `T_funding` (HH:MM:00) |
| `P_low` | Lowest price reached during the post-funding drop |
| `P_exit` | Actual exit price |

### Strategy Parameters

| Variable | Description |
|---|---|
| `F_threshold` | Minimum absolute funding rate to trigger a strategy |
| `SL` | Stop-loss distance (% from entry) |
| `TP` | Take-profit distance (% from entry or from average entry) |
| `retracement_pct` | Fibonacci/percentage retracement level for exit |
| `ladder_count` | Number of limit orders in a ladder |
| `ladder_top_mult` | Multiplier for top of ladder range |
| `ladder_bottom_mult` | Multiplier for bottom of ladder range |

### P&L Components

Every strategy's P&L decomposes into two forces:

```
NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
```

| Component | Long Position | Short Position |
|---|---|---|
| `DELTA_PNL` | `(P_exit - P_entry) / P_entry` | `(P_entry - P_exit) / P_entry` |
| `FUNDING_PNL` (when F is negative) | `+F` (longs receive) | `−F` (shorts pay) |
| `FEES` | `taker_fee × 2` (entry + exit for market orders) or `taker_fee + maker_fee` (market entry + limit exit) | same |

> **Key Insight:** With negative funding, longs *receive* the funding fee and shorts *pay* it. The strategies either profit from the funding payment (long strategies) or from the price drop (short strategies), each bearing the opposite as a cost.

---

## Exchange Fee Assumptions (per trade, one side)

| Fee Type | Typical Range |
|---|---|
| `taker_fee` | 0.02% – 0.06% |
| `maker_fee` | 0.00% – 0.02% |

> These must be parameterized per exchange in the backtester.

---

## Consolidated Variable Registry

### Input Variables (per funding event)

| Variable | Type | Source |
|---|---|---|
| `funding_rate` | float | Exchange API (predicted) |
| `T_funding` | datetime | Exchange funding schedule |
| `price_timeseries` | float[] | Tick/second-level OHLCV |
| `volume_24h` | float | Exchange API |
| `taker_fee` | float | Exchange fee schedule |
| `maker_fee` | float | Exchange fee schedule |

### Strategy Parameters (tunable)

Doc notation on the left, the actual key an operator edits in
`live-configs/strategies/<strategy>-<exchange>.yaml` on the right.

| Parameter | Live config key | Used In | Type | Schema default |
|---|---|---|---|---|
| `F_threshold` | `negativeFundingThresholdPercent` | 1, 1_ws, 2, 3a, 4.1a, 4.2a | float (percent, signed) | −0.4 to −0.5 |
| `entry_offset_seconds` | `entryOffsetSeconds` | all | int | 5s (or 10s) |
| `exit_offset_seconds` | `exitOffsetSeconds` | 1 | int | 2s |
| — | `fundingFeeTimeoutSeconds` | 1_ws, 2, 6 | int | 30s |
| `retracement_pct` | `retracementPct` | 2 | float [0, 1] | 0.50 |
| `SL` | `stopLossPercent` | 3a | float (fixed percent) | 1.0% |
| `TP` | `takeProfitPct` | 4.1a, 4.2a | float (percent) | varies |
| `TP_mode` | `tpVariantAMultiplier` | 3a | float | 1.5 |
| `ladder_count` | `ladderCount` | 4.1a | int | 5 |
| `ladder_top_mult` | `ladderTopMult` | 4.1a | float | 0.5 |
| `ladder_bottom_mult` | `ladderBottomMult` | 4.1a | float | 1.5 |
| `limit_offset_mult` | `limitOffsetMult` | 4.2a | float | 0.75 |
| `sl_mult` | `slMultiplier` | 2, 4.1a, 4.2a, 6 | float | 1.0–1.5 |
| `T_deadline` | `deadlineSeconds` | 2, 3a, 4.x, 6 | int (seconds) | 60s |
| — | `mainSide` | 6 | enum `long`/`short` | *(required)* |
| — | `funding_threshold` | 6 | float (percent, **signed**) | 0 |
| — | `tpMultiplier` | 6 | float | 0.5 |

### Sizing Parameters (every strategy)

| Live config key | Live value | Meaning |
|---|---|---|
| `amountUsd` (`mainAmountUsd` on strategy 6) | 10 | Notional per intent, in USD. Quantity = `amountUsd / price / contractSize`, floored to the exchange lot step. |
| `leverage` | 5 (**okx strategy_1: 4**) | Set via `setLeverage` before entry; failure is a hard reject. Leverage does **not** scale position size — notional is always `amountUsd`; leverage only sets the margin posted (`amountUsd / leverage`). |
| `enabled` | `true` | Strategy is skipped entirely when `false`. |

Code reference: `src/execution/strategies/shared/sizing.ts`.

### Output Variables (per trade)

| Variable | Description |
|---|---|
| `P_entry` | Actual entry price |
| `P_exit` | Actual exit price |
| `P_avg` | Average entry price (ladder strategies) |
| `delta_pnl` | Price movement P&L (%) |
| `funding_pnl` | Funding fee P&L (%) |
| `fee_cost` | Total fees paid (%) |
| `net_pnl` | Final net P&L (%) |
| `exit_reason` | Enum: `TP_HIT`, `SL_HIT`, `DEADLINE`, `MARKET_EXIT` |
| `hold_duration` | Seconds from entry to exit |
| `fill_count` | Number of limit orders filled (ladder) |
| `funding_received` | Boolean: did the position receive funding? |

---

## Safety Mechanisms

### Kill Switch

The engine exposes a kill switch with three states: `off`, `paused`, and `flatten`.

When `killSwitchMode !== 'off'`, `preflight()` rejects every new intent with `intent.error { code: 'kill_switch' }` before any exchange API call is made. No order is submitted; no network activity is visible on the exchange side. Operators watching exchange logs will see no activity — the rejection is engine-internal only.

The `flatten` mode additionally triggers `flattenAll()`, which issues reduce-only market orders to close all open positions across all exchanges.

Code reference: `src/execution/execution/preflight.ts:32`.

### Post-Exit Order Sweep (`sweepReduceOnlyOrders`)

After every intent exit (TP, SL, deadline, timed, or kill switch), the engine calls `sweepReduceOnlyOrders` to cancel any lingering reduce-only orders on the exchange for that symbol. This cleanup step runs asynchronously after the exit transition.

The sweep produces cancel API calls that appear in exchange logs after the close fill. These cancels are expected and not pathological — they are a safety net in case an SL or TP resting order was not consumed by the exit fill (e.g., both legs fired simultaneously, or the deadline market close filled while an SL/TP was still resting). Strategies that use `sl_tp_deadline` variants will always produce at least one post-exit cancel call per exit.

Code reference: `src/execution/execution/manager.ts` (`sweepReduceOnlyOrders`).

---

## Live Engine Behavior

These are engine-level behaviors that are **not** exposed as YAML parameters but
materially change which trades are taken and how they are executed. They apply to
every strategy.

### Order path

- **WS-mandatory strategies.** `strategy_1_ws`, `strategy_2`, and `strategy_6`
  place orders over the WebSocket order adapter and throw at startup if no
  adapter is available. OKX falls back to REST on `WS_TIMEOUT`; other exchanges
  do not.
- **Submission stagger.** Order submissions are serialized per exchange with a
  gap of 150 ms (bybit) or 100 ms (binance) to stay inside rate limits.
- **Rate-limit reservation.** 10% of each exchange's rate budget is reserved for
  critical calls (order submit / cancel) so a burst of market-data polling cannot
  starve execution.

### Fallbacks and hygiene

- **REST fill-poll.** If the WS misses a fill, the engine polls `getOrder` (10 s
  timeout, up to 15 polls) and circuit-opens on consecutive errors.
- **REST funding-fee poll.** For the WS-gated strategies, a REST poll fires at
  `T_funding + 3 s` with an 8 s grace period, catching a missed `ws.funding_fee`
  event.
- **Funding-fee event matching** tolerates a **±5 s** difference between the
  event's `fundingTime` and the expected `T_funding`.
- **Orphan-position auto-flatten** and a **stale reduce-only sweep before entry**
  clean up state left behind by a crash or a desync.

---

## Hard Parameter Bounds

These are enforced by the config loader (`src/backtesting/config/loader.ts`).
Proposals that violate them will fail the backtest and the iteration will be
reverted:

- `entry_offset_seconds >= 2` (market-order latency)
- `exit_offset_seconds  >= 2`
- `deadline_seconds`: 2 <= value <= 180
- `ladder_count >= 2`
- `sl_mult` (strategies 2, 4.1): >= 0.5 AND <= 4.0
- `sl_mult` (strategy 4.2): >= 1.0 AND <= 4.0; MUST be > `limit_offset_mult`

