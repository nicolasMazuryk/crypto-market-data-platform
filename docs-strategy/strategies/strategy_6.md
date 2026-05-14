# Strategy 6 — Extracted Spec

This is the extracted spec for Strategy 6. It contains only the sections
relevant to this strategy, pulled verbatim from
`docs-strategy/funding_rate_strategies.md`. For the full monolith, see that
file. For global variables and hard bounds, see `_globals.md`.

---

## Strategy 6: Post-Funding Directional — WS-Gated Entry

**Thesis:** Take a directional position (LONG or SHORT) whose entry is triggered by the WS `funding_fee` event — the moment funding accrues on the exchange. A tiny PRE_FUNDING_ORDER in the opposite direction is placed before funding to subscribe the symbol into the private WS user-data stream; the larger MAIN order reverses this position on the WS event. TP/SL/deadline manage exit. The funding-rate threshold is signed; its sign is independent of `mainSide` — all four combinations (long/short × positive/negative threshold) are legal.

> **Live-only.** This strategy cannot run in backtest mode because backtests cannot emulate WS funding-fee events. The backtest engine will reject any config that includes `strategy_6`.

### Parameters

| Parameter | Variable | Default |
|---|---|---|
| Trade direction | `mainSide` | *(required)* `long` or `short` |
| Funding-rate threshold (signed) | `funding_threshold` | `0` (always-on) |
| Pre-funding entry offset | `entryOffsetSeconds` | `10s` |
| WS funding-fee timeout | `fundingFeeTimeoutSeconds` | `8s` |
| TP multiplier | `tpMultiplier` | `0.5` |
| SL multiplier | `slMultiplier` | `1.0` |
| Deadline after funding | `deadlineSeconds` | `3300s` (55 min) |
| Main position size | `mainAmountUsd` | — |
| Leverage | `leverage` | — |

### Selection Logic

```
IF current_time == T_funding - entryOffsetSeconds
AND ((funding_threshold > 0 AND F% >= funding_threshold)
     OR (funding_threshold < 0 AND F% <= funding_threshold)
     OR funding_threshold == 0)
AND market.status == 'trading'
THEN trigger strategy
```

`mainSide` and `funding_threshold` are independent — all four combinations (long/short × positive/negative threshold) are legal.

### Execution Flow (LONG example; SHORT mirrors signs)

```
1. AT T_funding - entryOffsetSeconds:
   → PRE_FUNDING_ORDER: SELL MARKET (opposite to mainSide), size = min(exchange_lot, minNotional_qty)
     This tiny SHORT opens a position that subscribes the symbol to the private WS stream.

2. AWAIT ws.funding_fee for (exchange, symbol) with fundingTime ≈ T_funding (±5 s tolerance)
   Hard fallback at T_funding + fundingFeeTimeoutSeconds:
     → abort: MARKET-close PRE_FUNDING (reduce-only, size = preFundingVolume)
     → settle as funding_event_timeout

3. ON ws.funding_fee event:
   → MAIN: BUY MARKET (mainSide = LONG), size = mainVolume, via WS order adapter
   The PRE_FUNDING SHORT is reversed; net exchange position = mainVolume − preFundingVolume LONG

4. ON MAIN fill at price P_entry:
   → TP: SELL LIMIT at P_entry × (1 + |F%| × tpMultiplier / 100)
   → SL: SELL STOP-MARKET at P_entry × (1 − |F%| × slMultiplier / 100)
   → Arm deadline at T_funding + deadlineSeconds

5. EXIT (whichever comes first):
   → TP fill: cancel SL, settle
   → SL trigger: cancel TP, settle
   → Deadline: cancel both, MARKET-close net position, settle
```

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

| Parameter | Used In | Type | Default |
|---|---|---|---|
| `mainSide` | 6 | enum | *(required)* |
| `funding_threshold` | 6 | float (signed) | 0 |
| `entryOffsetSeconds` | 6 | int | 10s |
| `fundingFeeTimeoutSeconds` | 6 | int | 8s |
| `tpMultiplier` | 6 | float | 0.5 |
| `slMultiplier` | 6 | float | 1.0 |
| `deadlineSeconds` | 6 | int | 3300s |

---

## Strategy Comparison Matrix Row

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S6** | LONG or SHORT | Pre-fund opposite (tiny) + MAIN market on WS event | TP Limit / SL Stop-Market / Deadline | Directional move post-funding | 2 entries + 1 exit fees + PRE_FUNDING funding cost | WS event miss; MAIN slippage; thin liquidity |

---

## Backtesting Data Requirements

> **This strategy cannot be backtested.** The MAIN entry depends on receiving the `ws.funding_fee` event in real-time. Backtests cannot emulate private WS user-data streams.
