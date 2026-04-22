# Strategy 5 — Extracted Spec

This is the extracted spec for Strategy 5. It contains only the sections
relevant to this strategy, pulled verbatim from
`docs-strategy/funding_rate_strategies.md`. For the full monolith, see that
file. For global variables and hard bounds, see `_globals.md`.

---

## Strategy 5: Cross-Exchange Funding Arbitrage

**Thesis:** When Exchange A has a much larger negative funding rate than Exchange B, the price drop driven by Exchange A's settlement will propagate to Exchange B. Short on Exchange B to capture the price drop without paying the large funding fee.

### Parameters

| Parameter | Variable | Default |
|---|---|---|
| Exchange A funding threshold | `F_A_threshold` | 1.5% |
| Exchange B funding threshold | `F_B_max` | 0.4% (must be significantly smaller) |
| Funding spread threshold | `F_spread_threshold` | 1.0% (minimum `F_A - F_B`) |
| Entry offset | `T_entry` | `T_funding − 3s` |
| Take-profit | `TP` | `(F_A - F_B) / 2` |
| Volume/liquidity filter | `vol_ratio_threshold` | Exchange A volume > Exchange B volume |

### Selection Logic

```
IF current_time == T_funding - 3s
AND F_A < -F_A_threshold
AND F_B > -F_B_max                                 # B's funding is much smaller
AND (F_A - F_B) > F_spread_threshold               # sufficient spread
AND volume_A > volume_B × vol_ratio_threshold       # A leads price
THEN trigger strategy
```

### Liquidity/Volume Rules

```
PRICE LEADERSHIP LOGIC:
  IF volume_A >> volume_B:
    → Exchange A leads price → Exchange B follows
    → Strategy is VALID: short on B, expect B to follow A's drop
  
  IF volume_A << volume_B:
    → Exchange B leads price → A's funding event may not drag B
    → Strategy is INVALID: do not trade
  
  IF volume_A ≈ volume_B:
    → Unclear leadership → higher risk
    → Strategy is MARGINAL: reduce size or skip
```

### Execution Flow

```
1. AT T_funding - 3s (on Exchange B):
   → ENTRY: SELL MARKET at best bid on Exchange B
   → Record P_entry_B

2. TAKE-PROFIT:
   → BUY LIMIT at P_entry_B × (1 - TP)
   → where TP = (F_A - F_B) / 2

3. EXIT:
   → TP hit, OR
   → T_deadline → BUY MARKET (reduce-only)
```

### P&L Formula

```
DELTA_PNL   = (P_entry_B - P_exit_B) / P_entry_B
FUNDING_PNL = -F_B                                 # shorts pay negative funding on B
FEES        = taker_fee_B × 2                      # (or taker + maker if limit exit)

NET_PNL = DELTA_PNL - F_B - FEES
```

### Profit Condition

```
DELTA_PNL > F_B + FEES
```

> **The edge:** You capture most of Exchange A's price impact while only paying Exchange B's (much smaller) funding fee.

### Backtesting Variables to Extract

- `F_A`, `F_B` at each funding period
- `P_A`, `P_B` tick-by-tick around `T_funding`
- `volume_A`, `volume_B` (24h or 1h rolling)
- Price correlation between exchanges (lag analysis)

---

## Relevant Registry Rows

| Parameter | Used In | Type | Default |
|---|---|---|---|
| `F_A_threshold` | 5 | float | 1.5% |
| `F_B_max` | 5 | float | 0.4% |
| `F_spread_threshold` | 5 | float | 1.0% |
| `entry_offset_seconds` | 5 | int | 3s |
| `T_deadline` | 5 | int (seconds) | 60s |
| `vol_ratio_threshold` | 5 | float | TBD |

---

## Strategy Comparison Matrix Row

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S5** | SHORT (Exch B) | Market (−3s) | Limit (TP) or Market (deadline) | Cross-exchange delta | Funding fee (B) + fees | Price doesn't propagate |

---

## Backtesting Data Requirements

- Tick-level or 1-second candle data around each funding event (at least `[T_funding - 60s, T_funding + 120s]`)
- Predicted funding rate at each funding interval
- Exchange fee schedule (maker/taker)
- **Multi-exchange data** (for Strategy 5): both Exchange A and Exchange B price + volume data
- **Volume data** per exchange: for the liquidity leadership filter
- Price correlation between exchanges (lag analysis)
