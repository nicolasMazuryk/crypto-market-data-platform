# Strategy 3 — Extracted Spec

This is the extracted spec for Strategy 3 (covers sub-strategies 3a and 3b).
It contains only the sections relevant to this strategy, pulled verbatim from
`docs-strategy/funding_rate_strategies.md`. For the full monolith, see that
file. For global variables and hard bounds, see `_globals.md`.

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

## Relevant Registry Rows

| Parameter | Used In | Type | Default |
|---|---|---|---|
| `F_threshold` | 3 | float | 0.4% |
| `entry_offset_seconds` | 3 | int | 5s |
| `SL` | 3 | float | 1.0% |
| `TP` | 3 | float | varies |
| `TP_mode` | 3 | enum | A or B |

---

## Strategy Comparison Matrix Rows

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S3** | SHORT | Market (−5s) | Limit (TP) or Stop (SL) | Delta drop | Funding fee paid + fees | Drop < funding paid |

---

## Backtesting Data Requirements

- Tick-level or 1-second candle data around each funding event (at least `[T_funding - 60s, T_funding + 120s]`)
- Predicted funding rate at each funding interval
- Exchange fee schedule (maker/taker)
- Trade-by-trade data (for precise fill simulation of SL/TP)

---

## Spec Divergences

Known gaps between this spec and the live implementation.

| ID | Severity | Status |
|---|---|---|
| `DEADLINE_NOT_IN_SPEC` | medium | ⏳ |

### DEADLINE_NOT_IN_SPEC

**Category:** SPEC_DIVERGENCE

The spec describes exit as "SL or TP, whichever fires first." The code also implements a deadline timer (`deadlineAt = nextFundingTimestamp + deadlineSeconds`). If neither SL nor TP fills, the deadline forces a market close — behavior not mentioned in the spec.

**Preconditions:** neither SL nor TP fills before `deadlineAt`

**Trigger:** `deadlineAt` fires → market close placed

**Behavior:** intent exits with `exitReason="deadline"`

**Observability:**
- `monitor.deadline_fired`
- `intent.exited.complete` `{exitReason: "deadline"}`

**Code refs:**
- `src/execution/execution/monitor.ts:112` — deadline timer set
- `src/execution/strategies/strategy_3.ts:67` — `deadlineAt` in `exitPolicy`

**Note:** The deadline is a critical safety mechanism. Without it, a position could remain open indefinitely if both SL and TP orders fail to fill.
