# Strategy 4.2 — Extracted Spec

This is the extracted spec for Strategy 4.2 (covers sub-strategies 4.2a and 4.2b).
It contains only the sections relevant to this strategy, pulled verbatim from
`docs-strategy/funding_rate_strategies.md`. For the full monolith, see that
file. For global variables and hard bounds, see `_globals.md`.

---

## Strategy 4.2: Negative Funding Single LONG — Post-Funding Entry

**Thesis:** Simplified version of 4.1 — single limit buy instead of a ladder.

### Sub-Scenarios

| Scenario | Description | Funding Received? |
|---|---|---|
| Scenario 1 | Funding fee is NOT applied to the position | No |
| Scenario 2 | Funding fee IS applied to the position (exchange-dependent) | Yes (+F) |

> **Backtesting Note:** Scenario 1 and Scenario 2 must be backtested as **separate sub-strategies** (4.2a and 4.2b).

### Parameters

| Parameter | Variable | Default |
|---|---|---|
| Funding threshold | `F_threshold` | 0.6% |
| Limit offset | `limit_offset_mult` | 1.0 (i.e., `F × 1.0`) |
| Take-profit | `TP` | 0.2% above entry |
| Stop-loss multiplier | `sl_mult` | 1.5 — SL at `entry × (1 − F × sl_mult)`; MUST be > `limit_offset_mult` |
| Deadline | `T_deadline` | `T_funding + 60s` |

### Execution Flow

```
1. AT T_funding - 5s:
   → Record P_current
   → Place BUY LIMIT at: P_current × (1 - F × limit_offset_mult)

2. IF filled:
   → Place STOP-LOSS: SELL STOP at P_fill × (1 − F × sl_mult)
   → Place TAKE-PROFIT: SELL LIMIT at P_fill × (1 + TP)
   → Both active from the first candle after entry fill (OCO pair)

3. EXIT (whichever comes first):
   → SL hit: SELL STOP fires (taker fee)
   → TP hit: SELL LIMIT fills (maker fee)
   → T_deadline → SELL MARKET + cancel unfilled limit
```

### P&L Formula

Same structure as 4.1 but with single entry price instead of `P_avg`. Use Scenario 1 (FUNDING_PNL = 0) and Scenario 2 (FUNDING_PNL = +F) as separate sub-strategies.

---

## Relevant Registry Rows

| Parameter | Used In | Type | Default |
|---|---|---|---|
| `F_threshold_high` | 4.2 | float | 0.6% |
| `entry_offset_seconds` | 4.2 | int | 5s |
| `limit_offset_mult` | 4.2 | float | 1.0 |
| `TP` | 4.2 | float | 0.2% |
| `T_deadline` | 4.2 | int (seconds) | 60s |

---

## Strategy Comparison Matrix Rows

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S4.2a** | LONG | Single limit (−5s) | Stop (SL), Limit (TP), or Market (deadline) | Delta recovery | Fees | Not filled, or sharp drop triggers SL |
| **S4.2b** | LONG | Single limit (−5s) | Stop (SL), Limit (TP), or Market (deadline) | Delta recovery + funding | Fees | Not filled, or sharp drop triggers SL |

---

## Backtesting Data Requirements

- Tick-level or 1-second candle data around each funding event (at least `[T_funding - 60s, T_funding + 120s]`)
- Predicted funding rate at each funding interval
- Exchange fee schedule (maker/taker)
- **Funding fee scenarios:** Strategies 4.2a (funding excluded) and 4.2b (funding included) account for exchange-dependent funding on positions opened at the exact funding timestamp.

---

## Spec Divergences

Known gaps between this spec and the live implementation.

| ID | Severity | Status |
|---|---|---|
| `LIMIT_EXPIRED_UNDOCUMENTED` | high | ⏳ |

### LIMIT_EXPIRED_UNDOCUMENTED

**Category:** SPEC_DIVERGENCE

The spec describes only the successful fill scenario (step 2: "IF filled"). The code also handles the case where the limit order never fills by `deadlineAt`: it cancels the order and sets `error code=limit_expired`. The intent terminates with no position and no SL/TP placed — an undocumented code-only outcome.

**Preconditions:** limit order placed; price never reaches limit level before `deadlineAt`; `filledQty = 0` at expiry

**Trigger:** expiry timer fires at `deadlineAt` → `filledQty === 0` → `setError(s, 'limit_expired', ...)`

**Behavior:** intent errors out, no exchange position, no SL/TP placed

**Observability:**
- `intent.error` `{code: "limit_expired"}`
- DB: `intentLifecycleEvents` `working→error`

**Code refs:**
- `src/execution/execution/manager.ts:2642` — `setError limit_expired`

**Note:** Common in low-volatility periods after funding settlement when price does not dip to the limit level.
