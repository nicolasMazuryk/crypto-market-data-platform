# Strategy 5 — Main-Exchange-Driven Cross-Exchange Short

This is the extracted spec for Strategy 5. It contains only the sections
relevant to this strategy. For global variables and hard bounds, see `_globals.md`.

---

## Strategy 5: Main-Exchange-Driven Cross-Exchange Short

**Thesis:** When the most-liquid exchange (main) has deeply negative funding, it leads price down. Less-liquid target exchanges follow with a lag. Shorting on a target exchange captures the directional move while paying *less* funding cost (target's funding is less negative than main's — or even positive, receiving funding on the short).

### Parameters

| Parameter | Variable | Default |
|---|---|---|
| Main exchange | `main_exchange` | binance |
| Exclude exchanges | `exclude_exchanges` | [] |
| Main funding threshold | `main_exchange_funding_threshold` | 0.5% |
| Min funding spread | `min_funding_spread` | 0.4% |
| Stop loss | `stop_loss` | 0.5% above entry |
| TP multiplier | `tp_multiplier` | 1.5× |
| Entry offset | `entry_offset_seconds` | T_funding − 3s |
| Deadline | `deadline_seconds` | 60s |

### Selection Logic

```
FOR EACH funding event where:
  main_exchange.funding_rate < 0
  AND abs(main_exchange.funding_rate) >= main_exchange_funding_threshold
  AND EXISTS target_exchange NOT IN (main_exchange, exclude_exchanges):
    target.funding_rate - main.funding_rate >= min_funding_spread
THEN run one independent backtest per (main_event, eligible_target) pair
```

### Execution Flow

```
1. AT T_funding - entry_offset_seconds (on target_exchange):
   → ENTRY: SELL MARKET at best bid on target_exchange
   → Record entry_price

2. PLACE ORDERS:
   → BUY LIMIT  @ entry_price * (1 - |F_main| * tp_multiplier)  [TP]
   → BUY STOP   @ entry_price * (1 + stop_loss)                  [SL]
   → Both valid until T_funding + deadline_seconds

3. EXIT:
   → SL hit first (conservative tie-break), OR
   → TP hit, OR
   → DEADLINE → BUY MARKET at deadline candle
```

### P&L Formula

```
DELTA_PNL   = (entry_price - exit_price) / entry_price
FUNDING_PNL = -target_funding_rate          # shorts pay (negative = loss for short)
FEES        = taker_fee (entry) + maker_fee (TP) or taker_fee (SL/DEADLINE)

NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
```

### Backtesting Variables

- `F_main`, `F_target` at each funding period (all exchanges, same symbol/time tolerance)
- `P_target` tick-by-tick around `T_funding` (target exchange only)
- Exchange fee schedules (maker/taker per exchange)
- `exclude_exchanges` list

### Data Requirements

- `funding_rates` table: all exchanges, same symbol, within `funding_time_tolerance_seconds`
- Orderbook (1s candles) for each `target_exchange` around each matched event

---

## Parameter Bounds

| Parameter | Min | Max |
|---|---|---|
| `main_exchange_funding_threshold` | 0.002 | 0.015 |
| `min_funding_spread` | 0.001 | 0.015 |
| `stop_loss` | 0.001 | 0.020 |
| `tp_multiplier` | 0.1 | 3.0 |
| `entry_offset_seconds` | 1 | 5 |
| `deadline_seconds` | 10 | 900 |

---

## Strategy Comparison Matrix Row

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S5** | SHORT (target) | Market (−entry_offset) | Limit (TP) or Stop (SL) or Market (deadline) | Cross-exchange delta | Funding fee (target) + fees | Price doesn't propagate from main |
