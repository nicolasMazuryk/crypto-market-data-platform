# Strategy 4.1a — Extracted Spec

This is the extracted spec for Strategy 4.1a. It contains only the sections relevant
to this strategy. For global variables, engine behavior, and hard bounds, see
`_globals.md`.

---

## Strategy 4.1a: Negative Funding Ladder LONG — Post-Funding Entry

**Status:** deployed on all 6 exchanges.

**Thesis:** Place a ladder of limit buy orders below the current price to catch the post-funding drop, then exit at a profit target above average entry. The sharp price drop occurs at the funding timestamp, and limit orders are filled during/after this drop. Because the position opens *after* settlement, **no funding fee is received** — the entire edge is the delta recovery off the bottom of the drop.

### Parameters

| Parameter | Doc variable | Live config key | Live value | Schema default |
|---|---|---|---|---|
| Funding threshold | `F_threshold` | `negativeFundingThresholdPercent` | **−0.1** | −0.4 |
| Setup time | `T_setup` | `entryOffsetSeconds` | **3** (`T_funding − 3s`) | 5 |
| Ladder count | `ladder_count` | `ladderCount` | **5** | 5 (min 2) |
| Ladder top | `ladder_top_mult` | `ladderTopMult` | **0.7** | 0.5 |
| Ladder bottom | `ladder_bottom_mult` | `ladderBottomMult` | **1.8** | 1.5 |
| Take-profit | `TP` | `takeProfitPct` | **0.3** | 0.2 |
| Stop-loss multiplier | `sl_mult` | `slMultiplier` | **2.5** | 1.0 |
| Deadline | `T_deadline` | `deadlineSeconds` | **1800** (30 min) | 60 |
| Notional | — | `amountUsd` | 10 (split across rungs) | 20 |
| Leverage | — | `leverage` | 5 | 4 |


`ladderBottomMult` MUST be greater than `ladderTopMult` — enforced by the config loader.

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
   → Record P_current
   → Compute ladder range:
     ladder_top    = P_current × (1 - |F%| × ladderTopMult    / 100)
     ladder_bottom = P_current × (1 - |F%| × ladderBottomMult / 100)
   → Place ladderCount × BUY LIMIT orders, evenly spaced in offset space:
     prices[i] = ladder_top - i × (ladder_top - ladder_bottom) / (ladderCount - 1)
       for i in [0, ladderCount - 1]
   → Each unfilled rung carries expireAt = T_funding + deadlineSeconds

2. WAIT for fills during and after the funding event

3. AFTER T_funding, once unfilled rungs are cancelled:
   → Compute P_avg = weighted average of filled rung prices
   → Place STOP-LOSS:   SELL STOP  at P_avg × (1 − |F%| × slMultiplier / 100)
   → Place TAKE-PROFIT: SELL LIMIT at P_avg × (1 + takeProfitPct / 100)
   → OCO pair, anchored to the weighted-average fill

4. EXIT (whichever comes first):
   → SL hit: SELL STOP fires (taker fee)
   → TP hit: SELL LIMIT fills (maker fee)
   → T_deadline reached → SELL MARKET (reduce-only) + cancel unfilled limits
```

### Ladder Mechanics (live engine)

- **Quantity distribution.** `amountUsd` is split across the rungs using a
  **largest-remainder distribution** over the exchange lot step, so rounding does not
  silently lose size. Rungs are not necessarily equal in quantity.
- **Min-notional pre-check.** If even the *top* rung — priced at its most favourable
  level — fails the exchange's `minCost`, the symbol is skipped entirely before any
  order is placed. Individual rungs that fall below min-notional are dropped at
  placement time, so a ladder may go out with fewer than `ladderCount` orders.
- **Pre-funding fill.** A rung is *supposed* to fill after settlement. If one fills
  **before** `T_funding`, the position does accrue funding — contradicting the
  no-funding premise. The engine logs `ladder.pre_funding_fill` plus an ops event and
  **keeps the position** rather than closing it.
- **Post-error protective close.** If a rung fills after the intent has already
  errored with `ladder_no_fills` (a cancel/fill race), the engine places a reduce-only
  market close so no orphan position is left behind.

Code reference: `src/execution/strategies/strategy_4_1a.ts`.

### P&L Formula

```
P_avg = sum(filled_price[i] × qty[i]) / sum(qty[i])

DELTA_PNL   = (P_exit - P_avg) / P_avg
FUNDING_PNL = 0                                  # position opens after settlement

FEES = (num_filled_limits × maker_fee) + exit_fee
  where exit_fee = maker_fee (if TP limit) or taker_fee (if SL / deadline market)

NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
```

### Backtesting Variables to Extract

- `P` at `T_funding - entryOffsetSeconds` (for ladder placement)
- Tick-by-tick prices in `[T_funding - entryOffsetSeconds, T_deadline]` to determine which ladder levels filled
- `P` tick data after last fill to check if TP or SL was reached
- `P` at `T_deadline` (fallback)
- `F` at settlement

---

## Relevant Registry Rows

| Parameter | Live config key | Used In | Type | Live value |
|---|---|---|---|---|
| `F_threshold` | `negativeFundingThresholdPercent` | 4.1a | float | −0.1 |
| `entry_offset_seconds` | `entryOffsetSeconds` | 4.1a | int | 3s |
| `ladder_count` | `ladderCount` | 4.1a | int | 5 |
| `ladder_top_mult` | `ladderTopMult` | 4.1a | float | 0.7 |
| `ladder_bottom_mult` | `ladderBottomMult` | 4.1a | float | 1.8 |
| `TP` | `takeProfitPct` | 4.1a | float | 0.003 ⚠️ |
| `sl_mult` | `slMultiplier` | 4.1a | float | 2.5 |
| `T_deadline` | `deadlineSeconds` | 4.1a | int (seconds) | 1800s |

---

## Strategy Comparison Matrix Rows

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S4.1a** | LONG | Ladder limits (−3s) | Stop (SL), Limit (TP), or Market (deadline) | Delta recovery | Fees, unfilled orders | No recovery; sharp drop triggers SL |

---

## Backtesting Data Requirements

- Tick-level or 1-second candle data around each funding event (at least `[T_funding - 60s, T_funding + 120s]`)
- Predicted funding rate at each funding interval
- Exchange fee schedule (maker/taker)
- Trade-by-trade data (for precise fill simulation)
- **Partial fills:** the ladder may only partially fill. The backtester must track per-order fills.
- **No funding:** rungs fill during and after the price drop, so the position is opened after settlement and receives no funding fee. The backtester must model `FUNDING_PNL = 0`. A rung filling *before* `T_funding` is the one exception — the live engine keeps such a position, and it *does* accrue funding.
