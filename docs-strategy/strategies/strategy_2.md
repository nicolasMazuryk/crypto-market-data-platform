# Strategy 2 — Extracted Spec

This is the extracted spec for Strategy 2. It contains only the sections
relevant to this strategy, pulled verbatim from
`docs-strategy/funding_rate_strategies.md`. For the full monolith, see that
file. For global variables and hard bounds, see `_globals.md`.

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
| Stop-loss multiplier | `sl_mult` | 1.5 — SL at `P_entry × (1 − F × sl_mult)` |

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
   → Place STOP-LOSS: SELL STOP at P_entry × (1 − F × sl_mult)
     (active immediately from entry+1s)

2. AFTER T_funding (price drop occurs):
   → Observe P_funding (price at HH:MM:00)
   → Observe P_low (lowest price in the drop)
   → Compute retracement target:
     P_target = P_low + (P_funding - P_low) × retracement_pct
   → Place TAKE-PROFIT: SELL LIMIT at P_target
     (active from T_low+1s — TP only valid after P_low is identified)

3. EXIT (whichever comes first):
   → SL hit: SELL STOP triggers at P_SL (taker fee)
   → TP hit: SELL LIMIT at P_target (maker fee)
   → T_deadline reached and neither filled:
     SELL MARKET (reduce-only) at T_deadline (taker fee)
```

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

### Key Consideration

> **P_low identification problem:** In live trading, you don't know `P_low` in real-time. For backtesting this is straightforward, but for live execution you'd need a heuristic (e.g., "price hasn't made a new low for X seconds" or use a trailing approach). The backtester should model this realistically.

---

## Relevant Registry Rows

| Parameter | Used In | Type | Default |
|---|---|---|---|
| `F_threshold` | 2 | float | 0.4% |
| `entry_offset_seconds` | 2 | int | 5s |
| `retracement_pct` | 2 | float | 0.50 |
| `sl_mult` | 2 | float | 1.5 |
| `T_deadline` | 2 | int (seconds) | 60s |

---

## Strategy Comparison Matrix Row

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S2** | LONG | Market (−5s) | Stop (SL), Limit (retrace), or Market (deadline) | Funding fee + partial retrace | Residual delta + fees | No retracement; sharp drop triggers SL |

---

## Backtesting Data Requirements

- Tick-level or 1-second candle data around each funding event (at least `[T_funding - 60s, T_funding + 120s]`)
- Predicted funding rate at each funding interval
- Exchange fee schedule (maker/taker)
