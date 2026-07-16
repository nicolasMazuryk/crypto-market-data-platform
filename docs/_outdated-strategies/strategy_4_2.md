# Strategy 4.2a — Extracted Spec

This is the extracted spec for Strategy 4.2a. It contains only the sections relevant
to this strategy. For global variables, engine behavior, and hard bounds, see
`_globals.md`.

---

## Strategy 4.2a: Negative Funding Single LONG — Post-Funding Entry

**Status:** implemented, **not deployed** — and its live config is unusable as written.

**Thesis:** Simplified version of 4.1a — single limit buy instead of a ladder. The position opens *after* settlement, so **no funding fee is received**; the edge is the delta recovery off the drop.

### Parameters

Engine schema keys (what the loader accepts), with schema defaults. There are no
valid live values to quote — see the warning above.

| Parameter | Doc variable | Live config key | Schema default |
|---|---|---|---|
| Funding threshold | `F_threshold` | `negativeFundingThresholdPercent` | −0.4 |
| Entry offset | `T_entry` | `entryOffsetSeconds` | 5 |
| Limit offset | `limit_offset_mult` | `limitOffsetMult` | 0.75 |
| Take-profit | `TP` | `takeProfitPct` | 0.2 |
| Stop-loss multiplier | `sl_mult` | `slMultiplier` | 1.5 |
| Deadline | `T_deadline` | `deadlineSeconds` | 60 |
| Notional | — | `amountUsd` | 20 |
| Leverage | — | `leverage` | 4 |

`slMultiplier` MUST be greater than `limitOffsetMult` — enforced by the config loader.
Otherwise the stop would sit above the entry limit.

### Execution Flow

```
1. AT T_funding - entryOffsetSeconds:
   → Record P_current
   → Place BUY LIMIT at: P_current × (1 - |F%| × limitOffsetMult / 100)
   → The order carries expireAt = T_funding + deadlineSeconds

2. IF filled:
   → Place STOP-LOSS:   SELL STOP  at P_fill × (1 − |F%| × slMultiplier / 100)
   → Place TAKE-PROFIT: SELL LIMIT at P_fill × (1 + takeProfitPct / 100)
   → Both active from the first candle after entry fill (OCO pair)

3. EXIT (whichever comes first):
   → SL hit: SELL STOP fires (taker fee)
   → TP hit: SELL LIMIT fills (maker fee)
   → T_deadline → SELL MARKET + cancel unfilled limit

4. IF never filled by T_deadline:
   → Cancel the limit; intent terminates with error code = limit_expired
     (no position, no SL/TP placed)
```

`exitPolicy.kind = 'sl_tp_deadline'`.

### P&L Formula

Same structure as 4.1a but with a single entry price instead of `P_avg`, and
`FUNDING_PNL = 0` (the position opens after settlement).

---

## Relevant Registry Rows

| Parameter | Live config key | Used In | Type | Schema default |
|---|---|---|---|---|
| `F_threshold` | `negativeFundingThresholdPercent` | 4.2a | float | −0.4 |
| `entry_offset_seconds` | `entryOffsetSeconds` | 4.2a | int | 5s |
| `limit_offset_mult` | `limitOffsetMult` | 4.2a | float | 0.75 |
| `TP` | `takeProfitPct` | 4.2a | float | 0.2% |
| `sl_mult` | `slMultiplier` | 4.2a | float | 1.5 |
| `T_deadline` | `deadlineSeconds` | 4.2a | int (seconds) | 60s |

---

## Strategy Comparison Matrix Rows

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S4.2a** | LONG | Single limit | Stop (SL), Limit (TP), or Market (deadline) | Delta recovery | Fees | Not filled, or sharp drop triggers SL |

---

## Backtesting Data Requirements

- Tick-level or 1-second candle data around each funding event (at least `[T_funding - 60s, T_funding + 120s]`)
- Predicted funding rate at each funding interval
- Exchange fee schedule (maker/taker)
- **No funding:** the limit is intended to fill during the post-settlement drop, so the position receives no funding fee. The backtester must model `FUNDING_PNL = 0`.

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
