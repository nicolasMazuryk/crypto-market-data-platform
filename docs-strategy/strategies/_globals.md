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
| `T_funding` | Funding settlement timestamp (typically every 8h or 1h depending on exchange) |
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
| `funding_rate_A` | float | Exchange A API (Strategy 5) |
| `funding_rate_B` | float | Exchange B API (Strategy 5) |
| `T_funding` | datetime | Exchange funding schedule |
| `price_timeseries` | float[] | Tick/second-level OHLCV |
| `volume_24h` | float | Exchange API |
| `taker_fee` | float | Exchange fee schedule |
| `maker_fee` | float | Exchange fee schedule |

### Strategy Parameters (tunable)

| Parameter | Used In | Type | Default |
|---|---|---|---|
| `F_threshold` | 1, 2, 3 | float | 0.4% |
| `F_threshold_high` | 4.1, 4.2, 4.3 | float | 0.6% |
| `entry_offset_seconds` | 1, 2, 3, 5 | int | 5s (or 3s, 2s) |
| `exit_offset_seconds` | 1 | int | 2s |
| `retracement_pct` | 2 | float | 0.50 |
| `SL` | 3, 4.3 | float | 1.0% (or multiplier) |
| `TP` | 3, 4.x | float | varies |
| `TP_mode` | 3 | enum | A or B |
| `ladder_count` | 4.1 | int | 5 |
| `ladder_top_mult` | 4.1 | float | 0.4 |
| `ladder_bottom_mult` | 4.1 | float | 1.5 |
| `limit_offset_mult` | 4.2 | float | 1.0 |
| `entry_mult` | 4.3 | float | 0.75 |
| `sl_mult` | 2, 4.1, 4.2, 4.3 | float | 1.5 |
| `T_deadline` | 2, 4.x | int (seconds) | 60s |
| `F_A_threshold` | 5 | float | 1.5% |
| `F_B_max` | 5 | float | 0.4% |
| `F_spread_threshold` | 5 | float | 1.0% |
| `vol_ratio_threshold` | 5 | float | TBD |

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
- `sl_mult` (strategy 4.3): >= 0.5 AND <= 4.0; MUST be > `entry_mult`
