# Strategy 2 — Extracted Spec

This is the extracted spec for Strategy 2. It contains only the sections
relevant to this strategy, pulled verbatim from
`docs-strategy/funding_rate_strategies.md`. For the full monolith, see that
file. For global variables and hard bounds, see `_globals.md`.

---

## Strategy 2: Negative Funding LONG — Retracement Exit

**Status:** deployed on all 6 exchanges.

**Thesis:** Same as Strategy 1, but instead of immediately exiting at a loss from the price drop, wait for a partial price retracement to reduce (or eliminate) the delta cost.

### Parameters

| Parameter | Doc variable | Live config key | Live value | Schema default |
|---|---|---|---|---|
| Funding threshold | `F_threshold` | `negativeFundingThresholdPercent` | **−0.1** | −0.4 |
| Entry offset | `T_entry` | `entryOffsetSeconds` | **3** (`T_funding − 3s`) | 5 |
| Retracement level | `retracement_pct` | `retracementPct` | **1.0** (full retracement) | 0.5 |
| Deadline exit | `T_deadline` | `deadlineSeconds` | **900** (15 min) | 60 |
| Stop-loss multiplier | `sl_mult` | `slMultiplier` | **2.0** | 1.0 |
| Funding-fee event timeout | — | `fundingFeeTimeoutSeconds` | *(unset → 30)* | 30 |
| Notional | — | `amountUsd` | 10 | 20 |
| Leverage | — | `leverage` | 5 | 4 |

> **`retracementPct = 1.0` means the take-profit sits back at the anchor price** —
> the strategy waits for the price to fully recover to its pre-funding reference
> before exiting, rather than settling for a partial retrace. The `[0.3, 0.618]`
> Fibonacci range in the original spec is not what the fleet runs.

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
   → ENTRY: BUY MARKET at best ask (WS order adapter)
   → Record P_entry (fill) and anchorPrice (reference price at decision time)
   → Place STOP-LOSS: SELL STOP at P_entry × (1 − |F%| × slMultiplier / 100)
     (active immediately from entry)

2. ON ws.funding_fee event (fallback: fundingFeeTimeoutSeconds after T_funding):
   → ARM the retracement tracker

3. WHILE tracking (polls price every 1s):
   → Maintain a running P_low (lowest price seen since arming)
   → EACH TIME P_low makes a new low:
       P_target = P_low + (anchorPrice - P_low) × retracementPct
       → CANCEL the previous TP limit and RE-PLACE SELL LIMIT at P_target
       (throttled to at most one re-place per second)

4. EXIT (whichever comes first):
   → SL hit: SELL STOP triggers at P_SL (taker fee)
   → TP hit: SELL LIMIT at the current P_target (maker fee)
   → T_deadline (T_funding + 900s) reached and neither filled:
     SELL MARKET (reduce-only) (taker fee)
```

`exitPolicy.kind = 'sl_tp_deadline_retracement_funding_event'`.

Order placement is **WS-mandatory** for this strategy. The tracker is re-spawned
from the database on engine recovery, so a restart mid-position does not lose the
trailing TP.

Code references: `src/execution/strategies/strategy_2.ts`,
`src/execution/execution/manager.ts` (retracement tracker).

### P&L Formula

```
IF SL hit:
  DELTA_PNL = (P_SL_fill - P_entry) / P_entry   # P_SL_fill = sl_price × (1 - slippage)
  FEES      = taker_fee × 2                      # market entry + stop-market exit
IF TP hit (limit order filled):
  DELTA_PNL = (P_target - P_entry) / P_entry
  FEES      = taker_fee + maker_fee              # market entry + limit exit
IF deadline exit:
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

### Key Consideration — P_low Identification (resolved)

The original spec flagged this as an open problem: in live trading you cannot know
`P_low` in advance, so you cannot place a single correct retracement limit.

**The live engine solves it with a trailing take-profit rather than a one-shot
limit.** The tracker polls price every second and re-places the TP limit each time
the running low makes a new low, recomputing `P_target` from the new `P_low`. The
TP therefore chases the bottom down and settles wherever the drop actually ends —
no prediction required.

Two consequences the backtester must model to stay at parity:

- The TP is only armed **after the funding-fee event** (not at `T_funding`), so
  there is a window right after settlement in which only the SL is live.
- The TP price is a **function of the running minimum**, not of the final `P_low`.
  A backtest that places one limit at the true `P_low`-derived target is optimistic.

---

## Relevant Registry Rows

| Parameter | Live config key | Used In | Type | Live value |
|---|---|---|---|---|
| `F_threshold` | `negativeFundingThresholdPercent` | 2 | float | −0.1 |
| `entry_offset_seconds` | `entryOffsetSeconds` | 2 | int | 3s |
| `retracement_pct` | `retracementPct` | 2 | float | 1.0 |
| `sl_mult` | `slMultiplier` | 2 | float | 2.0 |
| `T_deadline` | `deadlineSeconds` | 2 | int (seconds) | 900s |
| — | `fundingFeeTimeoutSeconds` | 2 | int (seconds) | 30s (default) |

---

## Strategy Comparison Matrix Row

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S2** | LONG | Market (−3s) | Stop (SL), trailing Limit (retrace), or Market (deadline) | Funding fee + retrace | Residual delta + fees | No retracement; sharp drop triggers SL |

---

## Backtesting Data Requirements

- Tick-level or 1-second candle data around each funding event (at least `[T_funding - 60s, T_funding + 120s]`)
- Predicted funding rate at each funding interval
- Exchange fee schedule (maker/taker)
