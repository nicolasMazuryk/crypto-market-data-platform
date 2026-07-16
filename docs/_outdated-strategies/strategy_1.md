# Strategy 1 — Extracted Spec

This is the extracted spec for Strategy 1. It contains only the sections
relevant to this strategy, pulled verbatim from
`docs-strategy/funding_rate_strategies.md`. For the full monolith, see that
file. For global variables and hard bounds, see `_globals.md`.

---

## Strategy 1: Negative Funding LONG — Instant Exit

**Status:** deployed on all 6 exchanges.

**Thesis:** Collect funding fee by holding a long position through the settlement event, then immediately exit to minimize delta exposure.

### Parameters

| Parameter | Doc variable | Live config key | Live value | Schema default |
|---|---|---|---|---|
| Funding threshold | `F_threshold` | `negativeFundingThresholdPercent` | **−0.1** | −0.5 |
| Entry offset | `T_entry` | `entryOffsetSeconds` | **3** (`T_funding − 3s`) | 10 |
| Exit offset | `T_exit` | `exitOffsetSeconds` | **4** (`T_funding + 4s`) | 2 |
| Notional | — | `amountUsd` | 10 | 20 |
| Leverage | — | `leverage` | 5 (**okx: 4**) | 4 |

Strategy 1 is the only strategy with a purely **timed** exit — no SL, no TP, no
deadline. Exit reason is always `timed`.

### Selection Logic

```
IF current_time == T_funding - entryOffsetSeconds
AND funding_rate_percent <= -abs(negativeFundingThresholdPercent)    # i.e. <= -0.1%
AND market.status == 'trading'
THEN trigger strategy
```

### Execution Flow

```
1. AT T_funding - entryOffsetSeconds (live: -3s):
   → ENTRY: BUY MARKET at best ask

2. AT T_funding + exitOffsetSeconds (live: +4s):
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

- `P` at `T_funding - entryOffsetSeconds` (entry)
- `P` at `T_funding + exitOffsetSeconds` (exit)
- `F` at settlement

---

## Strategy Comparison Matrix Row

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S1** | LONG | Market (−3s) | Market (+4s), timed | Funding fee | Delta drop + fees | Drop > funding |

---

## Backtesting Data Requirements

- Tick-level or 1-second candle data around each funding event (at least `[T_funding - 60s, T_funding + 120s]`)
- Predicted funding rate at each funding interval
- Exchange fee schedule (maker/taker)
