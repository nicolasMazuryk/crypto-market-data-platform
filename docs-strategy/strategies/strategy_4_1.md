# Strategy 4.1 — Extracted Spec

This is the extracted spec for Strategy 4.1 (covers sub-strategies 4.1a and 4.1b).
It contains only the sections relevant to this strategy, pulled verbatim from
`docs-strategy/funding_rate_strategies.md`. For the full monolith, see that
file. For global variables and hard bounds, see `_globals.md`.

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

## Relevant Registry Rows

| Parameter | Used In | Type | Default |
|---|---|---|---|
| `F_threshold_high` | 4.1 | float | 0.6% |
| `entry_offset_seconds` | 4.1 | int | 5s |
| `ladder_count` | 4.1 | int | 5 |
| `ladder_top_mult` | 4.1 | float | 0.4 |
| `ladder_bottom_mult` | 4.1 | float | 1.5 |
| `TP` | 4.1 | float | 0.2% |
| `T_deadline` | 4.1 | int (seconds) | 60s |

---

## Strategy Comparison Matrix Rows

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S4.1a** | LONG | Ladder limits (−5s) | Limit (TP) or Market (deadline) | Delta recovery | Fees, unfilled orders | No recovery, full drop |
| **S4.1b** | LONG | Ladder limits (−5s) | Limit (TP) or Market (deadline) | Delta recovery + funding | Fees, unfilled orders | No recovery, full drop |

---

## Backtesting Data Requirements

- Tick-level or 1-second candle data around each funding event (at least `[T_funding - 60s, T_funding + 120s]`)
- Predicted funding rate at each funding interval
- Exchange fee schedule (maker/taker)
- Trade-by-trade data (for precise fill simulation)
- **Partial fills:** Ladder strategies (4.1) may only partially fill. The backtester must track per-order fills.
- **Funding fee scenarios:** The price drop occurs at the funding timestamp. Limit orders are filled during this drop at the same second. Some exchanges apply the funding fee to positions opened at the exact funding timestamp, some do not. Strategies 4.1a (funding excluded) and 4.1b (funding included) account for this.
