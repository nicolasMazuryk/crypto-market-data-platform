# Strategy 3a — Extracted Spec

This is the extracted spec for Strategy 3a. It contains only the sections relevant
to this strategy. For global variables, engine behavior, and hard bounds, see
`_globals.md`.

---

## Strategy 3a: Negative Funding SHORT — Ride the Drop

**Status:** implemented, **not deployed**. A config exists at
`live-configs/strategies/strategy_3a-<exchange>.yaml`, but `strategy_3a` is absent
from `live-configs/fleet.yaml` and so runs in no container.

**Thesis:** Instead of collecting funding (which you'd pay as a short), profit directly from the anticipated price drop. The price drop must exceed the funding fee paid.

### Parameters

| Parameter | Doc variable | Live config key | Live value | Schema default |
|---|---|---|---|---|
| Funding threshold | `F_threshold` | `negativeFundingThresholdPercent` | **−0.1** | −0.5 |
| Entry offset | `T_entry` | `entryOffsetSeconds` | **3** (`T_funding − 3s`) | 10 |
| Stop-loss | `SL` | `stopLossPercent` | **1.0** | 1.0 |
| Take-profit multiplier | `TP` | `tpVariantAMultiplier` | **1.5** (`TP = |F%| × 1.5`) | 1.5 |
| Deadline | `T_deadline` | `deadlineSeconds` | **900** (15 min) | 300 |
| Notional | — | `amountUsd` | 10 | 20 |
| Leverage | — | `leverage` | 5 | 4 |

> **`stopLossPercent` is a fixed percentage, not a multiple of the funding rate.**
> Unlike `slMultiplier` in strategies 2, 4.1a, and 6, this SL does not scale with
> `F` — a 1.0% adverse move stops the position out regardless of how negative
> funding was.

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
   → ENTRY: SELL MARKET at best bid
   → Record P_entry

2. IMMEDIATELY place (OCO pair):
   → STOP-LOSS:   BUY STOP-MARKET at P_entry × (1 + stopLossPercent / 100)
   → TAKE-PROFIT: BUY LIMIT       at P_entry × (1 − |F%| × tpVariantAMultiplier / 100)

3. EXIT (whichever comes first):
   → SL hit (taker fee)
   → TP hit (maker fee)
   → T_deadline (T_funding + 900s) → BUY MARKET (reduce-only), exitReason = deadline
```

`exitPolicy.kind = 'sl_tp_deadline'`.

### P&L Formula

```
IF take-profit hit:
  DELTA_PNL = +TP                                 # positive (short in profit)
  FEES      = taker_fee + maker_fee
ELSE IF stop-loss hit:
  DELTA_PNL = -SL                                 # negative (short stopped out)
  FEES      = taker_fee × 2
ELSE (deadline):
  DELTA_PNL = (P_entry - P_deadline) / P_entry
  FEES      = taker_fee × 2

FUNDING_PNL = -F                                   # shorts PAY on negative funding
NET_PNL     = DELTA_PNL + FUNDING_PNL - FEES
```

### Profit Condition

```
DELTA_PNL > F + FEES
```

> **The core bet:** the price drop magnitude exceeds the funding fee paid plus execution costs.

### Cannot Run Alongside a LONG Strategy

The config loader rejects any engine that enables `strategy_3a` together with a LONG
strategy (`strategy_1`, `strategy_1_ws`, `strategy_2`, `strategy_4_*a`) — the two
would offset each other inside the same funding window. This is one reason the fleet
runs one strategy per container. `strategy_6` is exempt, since its direction is
configurable.

### Backtesting Variables to Extract

- `P` at `T_funding - entryOffsetSeconds` (entry)
- `P_high` and `P_low` in window after entry (to check SL/TP triggers)
- Tick-by-tick price data to determine *which was hit first* (SL or TP)
- `P` at `T_deadline` (fallback exit)
- `F` at settlement

---

## Relevant Registry Rows

| Parameter | Live config key | Used In | Type | Live value |
|---|---|---|---|---|
| `F_threshold` | `negativeFundingThresholdPercent` | 3a | float | −0.1 |
| `entry_offset_seconds` | `entryOffsetSeconds` | 3a | int | 3s |
| `SL` | `stopLossPercent` | 3a | float | 1.0% |
| `TP` | `tpVariantAMultiplier` | 3a | float | 1.5 |
| `T_deadline` | `deadlineSeconds` | 3a | int (seconds) | 900s |

---

## Strategy Comparison Matrix Rows

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S3a** | SHORT | Market (−3s) | Limit (TP), Stop (SL), or Market (deadline) | Delta drop | Funding fee paid + fees | Drop < funding paid |

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
| `DEADLINE_NOT_IN_SPEC` | medium | ✅ resolved |

### DEADLINE_NOT_IN_SPEC — resolved

**Category:** SPEC_DIVERGENCE

The spec used to describe exit as "SL or TP, whichever fires first", omitting the
deadline timer (`deadlineAt = nextFundingTimestamp + deadlineSeconds`) that the code
has always implemented. If neither SL nor TP fills, the deadline forces a market
close with `exitReason="deadline"`.

The deadline is now documented in Parameters (`deadlineSeconds`, live 900s) and in
the Execution Flow above, so spec and code agree.

**Observability:**
- `monitor.deadline_fired`
- `intent.exited.complete` `{exitReason: "deadline"}`

**Code refs:**
- `src/execution/execution/monitor.ts` — deadline timer set
- `src/execution/strategies/strategy_3.ts` — `deadlineAt` in `exitPolicy`

**Note:** The deadline is a critical safety mechanism. Without it, a position could remain open indefinitely if both SL and TP orders fail to fill.
