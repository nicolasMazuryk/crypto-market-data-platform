# Crypto Perpetual Futures Funding Rate Strategies
## Backtesting Specification Document

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

---

# SINGLE EXCHANGE STRATEGIES

---

## Strategy 1: Negative Funding LONG — Instant Exit

**Thesis:** Collect funding fee by holding a long position through the settlement event, then immediately exit to minimize delta exposure.

### Parameters

| Parameter | Variable | Default |
|---|---|---|
| Funding threshold | `F_threshold` | 0.4% |
| Entry offset | `T_entry` | `T_funding − 5s` |
| Exit time | `T_exit` | `T_funding + 2s` |

### Selection Logic

```
IF current_time == T_funding - 5s
AND predicted_funding_rate < -F_threshold
THEN trigger strategy
```

### Execution Flow

```
1. AT T_funding - 5s:
   → ENTRY: BUY MARKET at best ask

2. AT T_funding + 2s:
   → EXIT: SELL MARKET (reduce-only) at best bid
```

### P&L Formula

```
DELTA_PNL  = (P_exit - P_entry) / P_entry        # likely negative (price drops)
FUNDING_PNL = +F                                   # received as long holder
FEES        = taker_fee × 2                        # two market orders

NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
```

### Profit Condition

```
F > |DELTA_PNL| + FEES
```

> **The core bet:** the funding fee received exceeds the price drop suffered plus execution fees.

### Backtesting Variables to Extract

- `P` at `T_funding - 5s` (entry)
- `P` at `T_funding + 2s` (exit)
- `F` at settlement

---

## Strategy 2: Negative Funding LONG — Retracement Exit

**Thesis:** Same as Strategy 1, but instead of immediately exiting at a loss from the price drop, wait for a partial price retracement to reduce (or eliminate) the delta cost.

### Parameters

| Parameter | Variable | Default |
|---|---|---|
| Funding threshold | `F_threshold` | 0.4% |
| Entry offset | `T_entry` | `T_funding − 5s` |
| Retracement level | `retracement_pct` | 0.50 (50%), range: [0.3, 0.618] |
| Deadline exit | `T_deadline` | `T_funding + 60s` |

### Selection Logic

```
IF current_time == T_funding - 5s
AND predicted_funding_rate < -F_threshold
THEN trigger strategy
```

### Execution Flow

```
1. AT T_funding - 5s:
   → ENTRY: BUY MARKET at best ask
   → Record P_entry

2. AFTER T_funding (price drop occurs):
   → Observe P_funding (price at HH:MM:00)
   → Observe P_low (lowest price in the drop)
   → Compute retracement target:
     P_target = P_low + (P_funding - P_low) × retracement_pct

3. EXIT (whichever comes first):
   → SELL LIMIT at P_target (placed after P_low is identified)
   → OR if T_deadline reached and limit not filled:
     SELL MARKET (reduce-only) at T_deadline
```

### P&L Formula

```
IF limit order filled:
  DELTA_PNL = (P_target - P_entry) / P_entry
  FEES      = taker_fee + maker_fee              # market entry + limit exit
ELSE (deadline exit):
  DELTA_PNL = (P_deadline - P_entry) / P_entry
  FEES      = taker_fee × 2                      # two market orders

FUNDING_PNL = +F
NET_PNL     = DELTA_PNL + FUNDING_PNL - FEES
```

### Backtesting Variables to Extract

- `P` at `T_funding - 5s` (entry)
- `P` at `T_funding` (reference for move start)
- `P_low` in window `[T_funding, T_deadline]`
- `T_low` (timestamp of lowest price — needed to know when to place limit)
- `P` tick-by-tick in `[T_low, T_deadline]` to check if `P_target` was reached
- `P` at `T_deadline` (fallback exit)
- `F` at settlement

### Key Consideration

> **P_low identification problem:** In live trading, you don't know `P_low` in real-time. For backtesting this is straightforward, but for live execution you'd need a heuristic (e.g., "price hasn't made a new low for X seconds" or use a trailing approach). The backtester should model this realistically.

---

## Strategy 3: Negative Funding SHORT — Ride the Drop

**Thesis:** Instead of collecting funding (which you'd pay as a short), profit directly from the anticipated price drop. The price drop must exceed the funding fee paid.

### Parameters

| Parameter | Variable | Default |
|---|---|---|
| Funding threshold | `F_threshold` | 0.4% |
| Entry offset | `T_entry` | `T_funding − 5s` |
| Stop-loss | `SL` | 1.0% |
| Take-profit mode A | `TP_a` | `F × 1.5` |
| Take-profit mode B | `TP_b` | `F + 0.4%` |

### Selection Logic

```
IF current_time == T_funding - 5s
AND predicted_funding_rate < -F_threshold
THEN trigger strategy
```

### Execution Flow

```
1. AT T_funding - 5s:
   → ENTRY: SELL MARKET at best bid
   → Record P_entry

2. IMMEDIATELY place:
   → STOP-LOSS: BUY STOP-MARKET at P_entry × (1 + SL)
   → TAKE-PROFIT (variant A): BUY LIMIT at P_entry × (1 - TP_a)
   → TAKE-PROFIT (variant B): BUY LIMIT at P_entry × (1 - TP_b)

3. EXIT: whichever is triggered first (SL or TP)
```

### P&L Formula

```
IF take-profit hit:
  DELTA_PNL = +TP                                 # positive (short in profit)
  FEES      = taker_fee + maker_fee
ELSE IF stop-loss hit:
  DELTA_PNL = -SL                                 # negative (short stopped out)
  FEES      = taker_fee × 2

FUNDING_PNL = -F                                   # shorts PAY on negative funding
NET_PNL     = DELTA_PNL + FUNDING_PNL - FEES
```

### Profit Condition

```
DELTA_PNL > F + FEES
```

> **The core bet:** the price drop magnitude exceeds the funding fee paid plus execution costs.

### Backtesting Variables to Extract

- `P` at `T_funding - 5s` (entry)
- `P_high` and `P_low` in window after entry (to check SL/TP triggers)
- Tick-by-tick price data to determine *which was hit first* (SL or TP)
- `F` at settlement

### Important Note on TP Variants

TP variant A (`F × 1.5`) and TP variant B (`F + 0.4%`) should be tested as **separate sub-strategies** (3A and 3B) in the backtester, as they have different risk/reward profiles.

---

## Strategy 4.1: Negative Funding Ladder LONG — Post-Funding Entry

**Thesis:** Place a ladder of limit buy orders below the current price to catch the post-funding drop, then exit at a profit target above average entry. The sharp price drop occurs at the funding timestamp, and limit orders are filled during/after this drop. On some exchanges, an order filled at the exact funding second may still receive the funding fee — this is exchange-dependent behavior.

### Sub-Scenarios

| Scenario | Description | Funding Received? |
|---|---|---|
| Scenario 1 | Funding fee is NOT applied to the position | No |
| Scenario 2 | Funding fee IS applied to the position (exchange-dependent) | Yes (+F) |

> **Backtesting Note:** Scenario 1 and Scenario 2 must be backtested as **separate sub-strategies** (4.1a and 4.1b) since the funding fee significantly impacts net P&L. This accounts for the uncertainty of whether the exchange applies funding to positions opened at the exact funding timestamp.

### Parameters

| Parameter | Variable | Default |
|---|---|---|
| Funding threshold | `F_threshold` | 0.6% |
| Setup time | `T_setup` | `T_funding − 5s` |
| Ladder count | `ladder_count` | 5 |
| Ladder top | `ladder_top_mult` | 0.4 |
| Ladder bottom | `ladder_bottom_mult` | 1.5 |
| Take-profit | `TP` | 0.2% above average filled price |
| Deadline | `T_deadline` | `T_funding + 60s` |

### Selection Logic

```
IF current_time == T_funding - 5s
AND predicted_funding_rate < -F_threshold
THEN trigger strategy
```

### Execution Flow

```
1. AT T_funding - 5s:
   → Record P_current
   → Compute ladder range:
     ladder_top    = P_current × (1 - F × ladder_top_mult)
     ladder_bottom = P_current × (1 - F × ladder_bottom_mult)
   → Place ladder_count × BUY LIMIT orders evenly spaced:
     prices[i] = ladder_top - i × (ladder_top - ladder_bottom) / (ladder_count - 1)
       for i in [0, ladder_count - 1]

2. WAIT for fills during and after funding event

3. AFTER fills (or partial fills):
   → Compute P_avg = weighted average of filled order prices
   → Place TAKE-PROFIT: SELL LIMIT at P_avg × (1 + TP)

4. EXIT:
   → TP hit, OR
   → T_deadline reached → SELL MARKET (reduce-only) + cancel unfilled limits
```

### P&L Formula

```
P_avg = sum(filled_price[i] × qty[i]) / sum(qty[i])

DELTA_PNL = (P_exit - P_avg) / P_avg

IF scenario 2 (funding included):
  FUNDING_PNL = +F
ELSE (scenario 1, funding excluded):
  FUNDING_PNL = 0

FEES = (num_filled_limits × maker_fee) + exit_fee
  where exit_fee = maker_fee (if TP limit) or taker_fee (if deadline market)

NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
```

### Backtesting Variables to Extract

- `P` at `T_funding - 5s` (for ladder placement)
- Tick-by-tick prices in `[T_funding - 5s, T_deadline]` to determine which ladder levels filled
- `P` tick data after last fill to check if TP was reached
- `P` at `T_deadline` (fallback)
- `F` at settlement

---

## Strategy 4.2: Negative Funding Single LONG — Post-Funding Entry

**Thesis:** Simplified version of 4.1 — single limit buy instead of a ladder.

### Sub-Scenarios

| Scenario | Description | Funding Received? |
|---|---|---|
| Scenario 1 | Funding fee is NOT applied to the position | No |
| Scenario 2 | Funding fee IS applied to the position (exchange-dependent) | Yes (+F) |

> **Backtesting Note:** Scenario 1 and Scenario 2 must be backtested as **separate sub-strategies** (4.2a and 4.2b).

### Parameters

| Parameter | Variable | Default |
|---|---|---|
| Funding threshold | `F_threshold` | 0.6% |
| Limit offset | `limit_offset_mult` | 1.0 (i.e., `F × 1.0`) |
| Take-profit | `TP` | 0.2% above entry |
| Deadline | `T_deadline` | `T_funding + 60s` |

### Execution Flow

```
1. AT T_funding - 5s:
   → Record P_current
   → Place BUY LIMIT at: P_current × (1 - F × limit_offset_mult)

2. IF filled:
   → Place TAKE-PROFIT: SELL LIMIT at P_fill × (1 + TP)

3. EXIT:
   → TP hit, OR
   → T_deadline → SELL MARKET + cancel unfilled limit
```

### P&L Formula

Same structure as 4.1 but with single entry price instead of `P_avg`. Use Scenario 1 (FUNDING_PNL = 0) and Scenario 2 (FUNDING_PNL = +F) as separate sub-strategies.

---

## Strategy 4.3: Negative Funding LONG — Limit Entry with SL/TP

**Thesis:** Refined version with tighter entry, explicit stop-loss, and fixed TP.

### Sub-Scenarios

| Scenario | Description | Funding Received? |
|---|---|---|
| Scenario 1 | Funding fee is NOT applied to the position | No |
| Scenario 2 | Funding fee IS applied to the position (exchange-dependent) | Yes (+F) |

> **Backtesting Note:** Scenario 1 and Scenario 2 must be backtested as **separate sub-strategies** (4.3a and 4.3b).

### Parameters

| Parameter | Variable | Default |
|---|---|---|
| Funding threshold | `F_threshold` | 0.6% |
| Entry offset | `T_entry` | `T_funding − 2s` |
| Limit price multiplier | `entry_mult` | 0.75 |
| Stop-loss multiplier | `sl_mult` | 1.5 |
| Take-profit | `TP` | 0.3% |
| Deadline | `T_deadline` | `T_funding + 60s` |

### Execution Flow

```
1. AT T_funding - 2s:
   → Record P_current
   → Place BUY LIMIT at: P_current × (1 - F × entry_mult)

2. IF filled:
   → Place STOP-LOSS: SELL STOP-MARKET at: P_current × (1 - F × sl_mult)
   → Place TAKE-PROFIT: SELL LIMIT at: P_fill × (1 + TP)

3. EXIT (whichever first):
   → TP hit
   → SL hit
   → T_deadline → SELL MARKET + cancel remaining orders
```

### P&L Formula

```
IF TP hit:
  DELTA_PNL = +TP
  FEES      = maker_fee × 2                       # limit entry + limit exit
ELSE IF SL hit:
  DELTA_PNL = (SL_price - P_fill) / P_fill        # negative
  FEES      = maker_fee + taker_fee                # limit entry + stop market exit
ELSE (deadline):
  DELTA_PNL = (P_deadline - P_fill) / P_fill
  FEES      = maker_fee + taker_fee

FUNDING_PNL = +F (scenario 2, funding included)
            = 0  (scenario 1, funding excluded)

NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
```

### Risk/Reward Profile

```
Max Loss  = F × sl_mult - F × entry_mult = F × (sl_mult - entry_mult)
          = F × (1.5 - 0.75) = F × 0.75
Max Gain  = TP + F (if funding received) = 0.3% + F
```

---

---

# MULTIPLE EXCHANGE STRATEGIES

---

## Strategy 5: Main-Exchange-Driven Cross-Exchange Short

**Thesis:** When the most-liquid exchange (main, e.g. Binance) has deeply negative funding, it leads price down. Less-liquid target exchanges follow. Shorting on a target exchange captures the directional move while paying a smaller funding cost (target's rate is less negative than main's). One independent trade is opened per eligible (main_event, target_exchange) pair.

### Parameters

| Parameter | Variable | Default |
|---|---|---|
| Main exchange | `main_exchange` | binance |
| Excluded exchanges | `exclude_exchanges` | [] |
| Main funding threshold | `main_exchange_funding_threshold` | 0.005 |
| Min funding spread | `min_funding_spread` | 0.004 |
| Stop-loss | `stop_loss` | 0.005 (0.5% above entry) |
| TP multiplier | `tp_multiplier` | 1.5 |
| Entry offset | `entry_offset_seconds` | 3 |
| Deadline | `deadline_seconds` | 60 |
| Funding time tolerance | `funding_time_tolerance_seconds` | 60 |

### Selection Logic

```
FOR EACH funding event on main_exchange where:
  main_exchange.funding_rate < 0
  AND abs(main_exchange.funding_rate) >= main_exchange_funding_threshold
  AND EXISTS target_exchange NOT IN (main_exchange ∪ exclude_exchanges):
    (target.funding_rate - main.funding_rate) >= min_funding_spread
    AND abs(target.funding_time - main.funding_time) <= funding_time_tolerance_seconds
THEN open one independent short trade per (main_event, eligible_target) pair
```

The spread condition `F_target − F_main >= min_spread` is equivalent to requiring main to be more negative than target by at least `min_spread`.

### Execution Flow

```
1. AT T_main_funding - entry_offset_seconds (on target_exchange):
   → ENTRY: SELL MARKET at best bid
   → Record entry_price
   → TP_price = entry_price × (1 - |F_main| × tp_multiplier)
   → SL_price = entry_price × (1 + stop_loss)

2. PLACE ORDERS (valid until T_main_funding + deadline_seconds):
   → BUY LIMIT  at TP_price   [take-profit]
   → BUY STOP   at SL_price   [stop-loss; wins on same-candle ambiguity]

3. EXIT (first trigger wins; SL beats TP on tie):
   → SL_HIT:    BUY at SL_price (taker)
   → TP_HIT:    BUY at TP_price (maker)
   → DEADLINE:  BUY MARKET at T_main_funding + deadline_seconds
```

### Funding Applicability

Funding is charged by the **target exchange** at its own `target_funding_time`, which may differ from `main_funding_time` by up to `funding_time_tolerance_seconds`. Funding applies to the position only if `target_funding_time` falls strictly within the position's open window `(entry_time, exit_time]`.

### P&L Formula

```
DELTA_PNL   = (entry_price - exit_price) / entry_price   # positive when price drops
FUNDING_PNL = -|F_target|  if funding applies            # shorts pay on negative rate
            = 0             otherwise
FEES        = taker_fee (entry) + maker_fee (TP) or taker_fee (SL / DEADLINE)

NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
```

### Profit Condition

```
DELTA_PNL > |F_target| + FEES
```

> **The edge:** Main exchange's deep negative funding drives a correlated price drop on target. Shorting the target captures the move while paying only the target's (smaller) funding cost.

### Parameter Bounds

| Parameter | Min | Max |
|---|---|---|
| `main_exchange_funding_threshold` | 0.002 | 0.015 |
| `min_funding_spread` | 0.001 | 0.015 |
| `stop_loss` | 0.001 | 0.020 |
| `tp_multiplier` | 0.1 | 3.0 |
| `entry_offset_seconds` | 1 | 5 |
| `deadline_seconds` | 10 | 900 |

### Backtesting Variables to Extract

- `F_main`, `F_target` at each matched funding period (within `funding_time_tolerance_seconds`)
- Orderbook (1s candles) for each target exchange around `T_main_funding`
- Per-exchange fee schedules (maker/taker)
- `target_funding_time` (for correct funding applicability, distinct from `main_funding_time`)

---

---

# CONSOLIDATED VARIABLE REGISTRY

All unique variables across all strategies, for backtester implementation.

## Input Variables (per funding event)

| Variable | Type | Source |
|---|---|---|
| `funding_rate` | float | Exchange API (predicted) |
| `funding_rate_main` | float | Main exchange API (Strategy 5) |
| `funding_rate_target` | float | Target exchange API (Strategy 5) |
| `T_funding` | datetime | Exchange funding schedule |
| `price_timeseries` | float[] | Tick/second-level OHLCV |
| `volume_24h` | float | Exchange API |
| `taker_fee` | float | Exchange fee schedule |
| `maker_fee` | float | Exchange fee schedule |

## Strategy Parameters (tunable)

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
| `sl_mult` | 4.3 | float | 1.5 |
| `T_deadline` | 2, 4.x | int (seconds) | 60s |
| `main_exchange_funding_threshold` | 5 | float | 0.5% |
| `min_funding_spread` | 5 | float | 0.4% |
| `funding_time_tolerance_seconds` | 5 | int | 60s |

## Output Variables (per trade)

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

# STRATEGY COMPARISON MATRIX

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S1** | LONG | Market (−5s) | Market (+2s) | Funding fee | Delta drop + fees | Drop > funding |
| **S2** | LONG | Market (−5s) | Limit (retrace) or Market (deadline) | Funding fee + partial retrace | Residual delta + fees | No retracement |
| **S3** | SHORT | Market (−5s) | Limit (TP) or Stop (SL) | Delta drop | Funding fee paid + fees | Drop < funding paid |
| **S4.1a** | LONG | Ladder limits (−5s) | Limit (TP) or Market (deadline) | Delta recovery | Fees, unfilled orders | No recovery, full drop |
| **S4.1b** | LONG | Ladder limits (−5s) | Limit (TP) or Market (deadline) | Delta recovery + funding | Fees, unfilled orders | No recovery, full drop |
| **S4.2a** | LONG | Single limit (−5s) | Limit (TP) or Market (deadline) | Delta recovery | Fees | Not filled, or no recovery |
| **S4.2b** | LONG | Single limit (−5s) | Limit (TP) or Market (deadline) | Delta recovery + funding | Fees | Not filled, or no recovery |
| **S4.3a** | LONG | Limit (−2s) | Limit (TP) / Stop (SL) / Market (deadline) | Delta recovery | SL risk, fees | Stopped out |
| **S4.3b** | LONG | Limit (−2s) | Limit (TP) / Stop (SL) / Market (deadline) | Delta recovery + funding | SL risk, fees | Stopped out |
| **S5** | SHORT (target) | Market (−entry_offset) | Limit (TP) / Stop (SL) / Market (deadline) | Cross-exchange delta | Funding fee (target) + fees | Price doesn't propagate from main |

---

# BACKTESTING DATA REQUIREMENTS

## Minimum Data

1. **Tick-level or 1-second candle data** around each funding event (at least `[T_funding - 60s, T_funding + 120s]`)
2. **Predicted funding rate** at each funding interval
3. **Exchange fee schedule** (maker/taker)

## Ideal Data

4. **Trade-by-trade data** (for precise fill simulation)
5. **Multi-exchange data** (for Strategy 5)
6. **Volume data** per exchange (for Strategy 5 liquidity filter)

## Backtesting Considerations

- **Funding fee scenarios for Strategies 4.x:** The price drop occurs at the funding timestamp. Limit orders are filled during this drop at the same second. Some exchanges apply the funding fee to positions opened at the exact funding timestamp, some do not. Strategies 4.1, 4.2, and 4.3 each have two sub-strategies (a: funding excluded, b: funding included) to account for this.
- **Partial fills:** Ladder strategies (4.1) may only partially fill. The backtester must track per-order fills.
- **Order placement latency:** A realistic backtester should account for 50-200ms network latency for order placement.
- **Exchange clock synchronization:** Entry at `T_funding - 5s` assumes accurate clock sync with the exchange.
