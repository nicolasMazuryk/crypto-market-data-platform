# Strategy 4.3 — Extracted Spec

This is the extracted spec for Strategy 4.3 (covers sub-strategies 4.3a and 4.3b).
It contains only the sections relevant to this strategy, pulled verbatim from
`docs-strategy/funding_rate_strategies.md`. For the full monolith, see that
file. For global variables and hard bounds, see `_globals.md`.

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

## Relevant Registry Rows

| Parameter | Used In | Type | Default |
|---|---|---|---|
| `F_threshold_high` | 4.3 | float | 0.6% |
| `entry_offset_seconds` | 4.3 | int | 2s |
| `entry_mult` | 4.3 | float | 0.75 |
| `sl_mult` | 4.3 | float | 1.5 |
| `TP` | 4.3 | float | 0.3% |
| `T_deadline` | 4.3 | int (seconds) | 60s |

---

## Strategy Comparison Matrix Rows

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S4.3a** | LONG | Limit (−2s) | Limit (TP) / Stop (SL) / Market (deadline) | Delta recovery | SL risk, fees | Stopped out |
| **S4.3b** | LONG | Limit (−2s) | Limit (TP) / Stop (SL) / Market (deadline) | Delta recovery + funding | SL risk, fees | Stopped out |

---

## Backtesting Data Requirements

- Tick-level or 1-second candle data around each funding event (at least `[T_funding - 60s, T_funding + 120s]`)
- Predicted funding rate at each funding interval
- Exchange fee schedule (maker/taker)
- Trade-by-trade data (for precise SL/TP fill simulation)
- **Funding fee scenarios:** Strategies 4.3a (funding excluded) and 4.3b (funding included) account for exchange-dependent funding on positions opened at the exact funding timestamp.
