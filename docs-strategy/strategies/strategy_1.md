# Strategy 1 — Extracted Spec

This is the extracted spec for Strategy 1. It contains only the sections
relevant to this strategy, pulled verbatim from
`docs-strategy/funding_rate_strategies.md`. For the full monolith, see that
file. For global variables and hard bounds, see `_globals.md`.

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

## Strategy Comparison Matrix Row

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S1** | LONG | Market (−5s) | Market (+2s) | Funding fee | Delta drop + fees | Drop > funding |

---

## Backtesting Data Requirements

- Tick-level or 1-second candle data around each funding event (at least `[T_funding - 60s, T_funding + 120s]`)
- Predicted funding rate at each funding interval
- Exchange fee schedule (maker/taker)
