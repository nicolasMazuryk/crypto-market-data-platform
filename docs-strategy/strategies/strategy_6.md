# Strategy 6 — Extracted Spec

This is the extracted spec for Strategy 6. For global variables, engine behavior,
and hard bounds, see `_globals.md`.

---

## Strategy 6: Post-Funding Directional — WS-Gated Entry

**Status:** deployed on all 6 exchanges.

**Thesis:** Take a directional position (LONG or SHORT) whose entry is triggered by the WS `funding_fee` event — the moment funding accrues on the exchange. A tiny PRE_FUNDING_ORDER in the opposite direction is placed before funding to subscribe the symbol into the private WS user-data stream; the larger MAIN order reverses this position on the WS event. TP/SL/deadline manage exit. The funding-rate threshold is signed; its sign is independent of `mainSide` — all four combinations (long/short × positive/negative threshold) are legal.

> **Strategy 6 is not a negative-funding strategy.** It is the one strategy in this
> document whose thesis is not "funding is deeply negative". It bets on the
> *directional move* that follows settlement, in whichever direction `mainSide` says
> — see the live configuration below.

### Parameters

| Parameter | Live config key | Live value | Schema default |
|---|---|---|---|
| Trade direction | `mainSide` | **`long`** (all 6) | *(required)* |
| Funding-rate threshold (signed, percent) | `funding_threshold` | **+0.1** | 0 (always-on) |
| Pre-funding entry offset | `entryOffsetSeconds` | **3** | 10 |
| WS funding-fee timeout | `fundingFeeTimeoutSeconds` | **10** (**okx: 45**) | 30 |
| TP multiplier | `tpMultiplier` | **1.5** | 0.5 |
| SL multiplier | `slMultiplier` | **1.5** | 1.0 |
| Deadline after funding | `deadlineSeconds` | **1800** (30 min) | 3300 |
| Main position size | `mainAmountUsd` | **10** | *(required)* |
| Leverage | `leverage` | **5** | *(required)* |

> **The live fleet goes LONG on POSITIVE funding.** `mainSide: long` with
> `funding_threshold: +0.1` means the strategy fires when funding is **≥ +0.1%** —
> the opposite regime from every other strategy in this document, which trigger on
> funding ≤ −0.1%. The bet is that the post-settlement move on a positively-funded
> symbol is upward, not that funding is collected. Do not assume the negative-funding
> framing of Strategies 1–4 applies here.

> Note `funding_threshold` is the only **snake_case** strategy key in the whole config
> schema; every other param is camelCase. The size key is `mainAmountUsd`, not
> `amountUsd`.

> **OKX runs a 45s WS timeout** rather than 10s — its private funding-fee event is
> materially slower to arrive.

### Selection Logic

```
IF current_time == T_funding - entryOffsetSeconds
AND ((funding_threshold > 0 AND F% >= funding_threshold)     # live: F% >= +0.1
     OR (funding_threshold < 0 AND F% <= funding_threshold)
     OR funding_threshold == 0)
AND market.status == 'trading'
AND preFundingQty < mainQty                                   # else no net exposure — skip
THEN trigger strategy
```

`mainSide` and `funding_threshold` are independent — all four combinations (long/short × positive/negative threshold) are legal.

**Sizing guard:** the symbol is skipped entirely if the minimum possible PRE_FUNDING
quantity is greater than or equal to the MAIN quantity — reversing would leave no net
position. This is re-checked at submission time against a fresh price.

### Execution Flow (LONG example; SHORT mirrors signs)

```
1. AT T_funding - entryOffsetSeconds:
   → PRE_FUNDING_ORDER: SELL MARKET (opposite to mainSide), size = min(exchange_lot, minNotional_qty)
     This tiny SHORT opens a position that subscribes the symbol to the private WS stream.

2. AWAIT ws.funding_fee for (exchange, symbol) with fundingTime ≈ T_funding (±5 s tolerance)
   Hard fallback at T_funding + fundingFeeTimeoutSeconds:
     → abort: MARKET-close PRE_FUNDING (reduce-only, size = preFundingVolume)
       Retried up to 3× with 250 / 1000 / 3000 ms backoff; a REST position fetch is
       treated as ground truth for what actually needs closing.
     → settle as funding_event_timeout

3. ON ws.funding_fee event:
   → Confirm the PRE_FUNDING order actually filled (else abort + close)
   → MAIN: BUY MARKET (mainSide = LONG), size = mainVolume, via WS order adapter
   The PRE_FUNDING SHORT is reversed; net exchange position = mainVolume − preFundingVolume LONG
   A mainEventLock guarantees the MAIN order fires exactly once.

4. ON MAIN fill at price P_entry:
   → Confirm net position qty via REST getPositions()
   → TP: SELL LIMIT at P_entry × (1 + |F%| × tpMultiplier / 100)
   → SL: SELL STOP-MARKET at P_entry × (1 − |F%| × slMultiplier / 100)
   → tpPct and slPct are computed at FILL time, not at decision time
   → TP/SL are sized on the NET qty (filledQty − preFundingVolume)
   → Arm deadline at T_funding + deadlineSeconds

5. EXIT (whichever comes first):
   → TP fill: cancel SL, settle
   → SL trigger: cancel TP, settle
   → Deadline: cancel both, MARKET-close net position, settle
```

### Error Codes

Strategy 6 has the most elaborate entry state machine and a correspondingly specific
set of terminal error codes. These are the ones to watch in ops:

| Code | Meaning |
|---|---|
| `pre_funding_order_failed` | PRE_FUNDING order submission threw |
| `pre_funding_order_rejected` | Exchange rejected the PRE_FUNDING order |
| `pre_funding_not_filled` | WS event arrived but PRE_FUNDING never filled — MAIN is not sent |
| `funding_event_timeout` | No `ws.funding_fee` within `fundingFeeTimeoutSeconds`; PRE_FUNDING closed |
| `main_order_failed` | MAIN order submission threw |
| `main_order_rejected` | Exchange rejected the MAIN order |
| `close_pre_funding_failed` | Abort path could not flatten the PRE_FUNDING position (all 3 retries failed) |

### P&L Formula

```
PRE_FUNDING_DELTA = (P_main_entry - P_pre_fill) × preFundingVolume × (-1)   # tiny opposing delta
FUNDING_PRE       = − funding_fee_paid_on_pre_funding_position               # cost (wrong direction)
MAIN_DELTA        = (P_exit - P_entry) × (mainVolume - preFundingVolume)     # net position delta
FEES              = taker_fee × 2  (PRE_FUNDING + MAIN entries)
                  + maker_fee or taker_fee for exit
NET_PNL = PRE_FUNDING_DELTA + FUNDING_PRE + MAIN_DELTA − FEES
```

Note: `FUNDING_PRE` is always negative (PRE_FUNDING is in the wrong direction). It is minimised by using the smallest possible PRE_FUNDING size.

### Profit Condition

```
MAIN_DELTA > |PRE_FUNDING_DELTA| + FUNDING_PRE + FEES
```

The directional bet must overcome PRE_FUNDING cost and fees.

### Key Risks

- **WS event miss:** if `ws.funding_fee` never arrives, the hard timeout at `T_funding + fundingFeeTimeoutSeconds` fires and the PRE_FUNDING position is closed at a small loss.
- **PRE_FUNDING funding cost:** PRE_FUNDING position accrues funding in the wrong direction.
- **MAIN slippage:** MAIN is a market order placed immediately after the WS event; liquidity around the funding spike may be thin.
- **Ordering caveat:** the MAIN fill completes after the funding event, so the funding fee on MAIN is **not** received this cycle.
- **Exchange ordering of funding settlement:** on some exchanges, funding is settled FIFO — the PRE_FUNDING position receives the funding fee, MAIN does not (accrues in next cycle).

---

## Relevant Registry Rows

| Live config key | Used In | Type | Live value | Schema default |
|---|---|---|---|---|
| `mainSide` | 6 | enum | `long` | *(required)* |
| `funding_threshold` | 6 | float (percent, signed) | +0.1 | 0 |
| `entryOffsetSeconds` | 6 | int | 3s | 10s |
| `fundingFeeTimeoutSeconds` | 6 | int | 10s (okx 45s) | 30s |
| `tpMultiplier` | 6 | float | 1.5 | 0.5 |
| `slMultiplier` | 6 | float | 1.5 | 1.0 |
| `deadlineSeconds` | 6 | int | 1800s | 3300s |
| `mainAmountUsd` | 6 | float | 10 | *(required)* |
| `leverage` | 6 | int | 5 | *(required)* |
| `preFundingVolume` | 6 | derived | min lot / min-notional qty | *(not configurable)* |

---

## Strategy Comparison Matrix Row

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S6** | LONG or SHORT | Pre-fund opposite (tiny) + MAIN market on WS event | TP Limit / SL Stop-Market / Deadline | Directional move post-funding | 2 entries + 1 exit fees + PRE_FUNDING funding cost | WS event miss; MAIN slippage; thin liquidity |

---

## Backtesting Data Requirements

> **This strategy cannot be backtested.** The MAIN entry depends on receiving the `ws.funding_fee` event in real-time. Backtests cannot emulate private WS user-data streams.

---

## Spec Divergences

Known gaps between this spec and the live implementation.

| ID | Severity | Status |
|---|---|---|
| `GETPOSITIONS_POST_MAIN_FILL` | medium | ⏳ |

### GETPOSITIONS_POST_MAIN_FILL

**Category:** SPEC_DIVERGENCE

After MAIN fill, the code calls `rest.getPositions()` to confirm actual net position qty before placing SL+TP. The spec does not mention this — it implicitly assumes `mainVolume - preFundingVolume` is correct. This REST round-trip is a defense against exchange-side netting quirks.

**Preconditions:** MAIN order filled; `exitPolicy.kind=sl_tp_deadline_post_funding_event`

**Trigger:** `handleEntryFilled` → `getPositions()` REST call

**Behavior:**
- REST succeeds → `exitQty = pos.qty`
- REST fails → warn + fallback to tracked fills

**Observability:**
- warn: `'strategy6: position fetch failed, falling back to tracked fills'` (on failure only; success is silent)

**Code refs:**
- `src/execution/execution/manager.ts:609` — `getPositions` call
- `src/execution/execution/manager.ts:619` — position fetch failed warn

**Note:** Adds ~100–300ms latency on Binance FAPI. SL+TP placement window is not tightly specified so acceptable. If latency is a concern, consider caching position from WS `ACCOUNT_UPDATE`.
