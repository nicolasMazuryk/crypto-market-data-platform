# Crypto Perpetual Futures Funding Rate Strategies
## Backtesting & Live Execution Specification

---

## Core Hypothesis

Tokens with significantly negative funding rates experience sharp price drops (−0.5% to −3%) within seconds of the funding settlement event. This document formalizes strategies to exploit this inefficiency.

Strategy 6 is the exception: it bets on the directional move after settlement in either direction, and the live fleet runs it on *positive* funding.

---

## Deployment Status

The live fleet is declared in `live-configs/fleet.yaml`: **30 containers**, one
strategy per container, across 6 exchanges (binance, bybit, okx, gateio, kucoin,
bitget). Per-instance params live in
`live-configs/strategies/<strategy>-<exchange>.yaml`.

| Strategy | Live ID | Implemented | Deployed | Notes |
|---|---|---|---|---|
| 1 | `strategy_1` | ✅ | ✅ 6 exchanges | |
| 1 WS | `strategy_1_ws` | ✅ | ✅ 6 exchanges | |
| 2 | `strategy_2` | ✅ | ✅ 6 exchanges | |
| 3a | `strategy_3a` | ✅ | ❌ | Config exists, absent from `fleet.yaml` |
| 4.1a | `strategy_4_1a` | ✅ | ✅ 6 exchanges | |
| 4.2a | `strategy_4_2a` | ✅ | ❌ | Config exists but is written in the wrong (backtest) schema — see §4.2a |
| 6 | `strategy_6` | ✅ | ✅ 6 exchanges | Live-only; cannot be backtested |

The engine runs **one strategy per container** because the config loader forbids
enabling a SHORT strategy (3a) alongside any LONG strategy in the same engine — they
would offset each other inside the same funding window.

---

## Global Definitions & Variables

### Timing

| Variable | Description |
|---|---|
| `T_funding` | Funding settlement timestamp (every 1h, 2h, 4h, or 8h depending on market conditions) |
| `T_entry` | Entry time relative to `T_funding` (e.g., `T_funding - 3s`) |
| `T_exit` | Exit time (strategy-dependent) |
| `T_deadline` | Maximum time to hold position before forced exit |

### Market Data

| Variable | Description |
|---|---|
| `F` | Current predicted funding rate (as a positive decimal, e.g., 0.015 for −1.5%). Always expressed as absolute value in formulas; the sign context (negative) is given by the strategy selection filter |
| `P_entry` | Price at entry |
| `P_funding` | Price at exact `T_funding` (HH:MM:00) |
| `P_low` | Lowest price reached during the post-funding drop |
| `P_exit` | Actual exit price |

### P&L Components

Every strategy's P&L decomposes into two forces:

```
NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
```

| Component | Long Position | Short Position |
|---|---|---|
| `DELTA_PNL` | `(P_exit - P_entry) / P_entry` | `(P_entry - P_exit) / P_entry` |
| `FUNDING_PNL` (when F is negative) | `+F` (longs receive) | `−F` (shorts pay) |
| `FEES` | `taker_fee × 2` (entry + exit for market orders) or `taker_fee + maker_fee` (market entry + limit exit) | same |

> **Key Insight:** With negative funding, longs *receive* the funding fee and shorts *pay* it. The strategies either profit from the funding payment (Strategies 1, 1 WS, 2), from the price drop (Strategy 3a), or from the delta recovery after the drop (Strategies 4.x), each bearing the opposite as a cost.

---

## Exchange Fee Assumptions (per trade, one side)

| Fee Type | Typical Range |
|---|---|
| `taker_fee` | 0.02% – 0.06% |
| `maker_fee` | 0.00% – 0.02% |

> These must be parameterized per exchange in the backtester.

---

## Sizing (every strategy)

| Live config key | Live value | Meaning |
|---|---|---|
| `amountUsd` (`mainAmountUsd` on Strategy 6) | 10 | Notional per intent, USD. Qty = `amountUsd / price / contractSize`, floored to the exchange lot step. |
| `leverage` | 5 (**okx Strategy 1: 4**) | Set via `setLeverage` before entry; failure is a hard reject. Does **not** scale position size — notional is always `amountUsd`; leverage only sets the margin posted. |
| `enabled` | `true` | Strategy is skipped entirely when `false`. |

---

## Strategy 1: Negative Funding LONG — Instant Exit

**Status:** deployed on all 6 exchanges.

**Thesis:** Collect funding fee by holding a long position through the settlement event, then immediately exit to minimize delta exposure.

### Parameters

| Parameter | Doc variable | Live config key | Live value | Schema default |
|---|---|---|---|---|
| Funding threshold | `F_threshold` | `negativeFundingThresholdPercent` | **−0.1** | −0.5 |
| Entry offset | `T_entry` | `entryOffsetSeconds` | **3** (`T_funding − 3s`) | 10 |
| Exit offset | `T_exit` | `exitOffsetSeconds` | **4** (`T_funding + 4s`) | 2 |

Strategy 1 is the only strategy with a purely **timed** exit — no SL, no TP, no
deadline. Exit reason is always `timed`.

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
   → ENTRY: BUY MARKET at best ask

2. AT T_funding + exitOffsetSeconds (live: +4s):
   → EXIT: SELL MARKET (reduce-only) at best bid
```

### P&L Formula

```
DELTA_PNL   = (P_exit - P_entry) / P_entry       # likely negative (price drops)
FUNDING_PNL = +F                                  # received as long holder
FEES        = taker_fee × 2                       # two market orders

NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
```

### Profit Condition

```
F > |DELTA_PNL| + FEES
```

> **The core bet:** the funding fee received exceeds the price drop suffered plus execution fees.

---

## Strategy 1 WS: Negative Funding LONG — Funding-Fee Event Exit

**Status:** deployed on all 6 exchanges.

**Thesis:** Same entry as Strategy 1, but exit as soon as the exchange confirms the funding fee on the private WebSocket stream — minimizing post-settlement delta exposure without exiting *before* funding is actually credited.

### Parameters

| Parameter | Doc variable | Live config key | Live value | Schema default |
|---|---|---|---|---|
| Funding threshold | `F_threshold` | `negativeFundingThresholdPercent` | **−0.1** | −0.5 |
| Entry offset | `T_entry` | `entryOffsetSeconds` | **3** | 10 |
| Funding-fee event timeout | `T_timeout` | `fundingFeeTimeoutSeconds` | **10** (**okx: 45**) | 30 |

> **OKX runs a 45s timeout** rather than 10s, because its private funding-fee event is materially slower to arrive. 10s there would cause routine false timeouts.

### Execution Flow

```
1. AT T_funding - entryOffsetSeconds (live: -3s):
   → ENTRY: BUY MARKET at best ask (WS order adapter)

2. AFTER T_funding:
   → WAIT for the private ws.funding_fee event for this (exchange, symbol).
     The event's fundingTime must match T_funding within ±5s to be accepted.

3. ON funding-fee event:
   → EXIT: SELL MARKET reduce-only at best bid      # exitReason = funding_fee_event

4. IF no event within fundingFeeTimeoutSeconds after T_funding:
   → EXIT: SELL MARKET reduce-only                  # exitReason = funding_fee_timeout
```

`exitPolicy.kind = 'funding_fee_event'`.

### WS-Miss Safety Net

A **REST funding-fee poll** fires at `T_funding + 3s` with an **8s grace period**. If
it observes the funding credit before the WS event arrives, the funding gate opens and
the exit proceeds normally. The `fundingFeeTimeoutSeconds` fallback sits behind that.

Order placement is **WS-mandatory** (the engine throws at startup without a WS order
adapter). OKX — and only OKX — falls back to REST on `WS_TIMEOUT`.

### Difference From Strategy 1

Strategy 1 exits at a fixed offset. Strategy 1 WS exits on the private-stream event, so
the exit can land earlier or later depending on exchange event timing, WS latency,
reconnect behavior, and the timeout.

### P&L Formula

```
DELTA_PNL   = (P_exit_ws - P_entry) / P_entry
FUNDING_PNL = +F
FEES        = taker_fee × 2

NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
```

---

## Strategy 2: Negative Funding LONG — Retracement Exit

**Status:** deployed on all 6 exchanges.

**Thesis:** Same as Strategy 1, but instead of immediately exiting at a loss from the price drop, wait for a price retracement to reduce (or eliminate) the delta cost.

### Parameters

| Parameter | Doc variable | Live config key | Live value | Schema default |
|---|---|---|---|---|
| Funding threshold | `F_threshold` | `negativeFundingThresholdPercent` | **−0.1** | −0.4 |
| Entry offset | `T_entry` | `entryOffsetSeconds` | **3** | 5 |
| Retracement level | `retracement_pct` | `retracementPct` | **1.0** (full retracement) | 0.5 |
| Deadline exit | `T_deadline` | `deadlineSeconds` | **900** (15 min) | 60 |
| Stop-loss multiplier | `sl_mult` | `slMultiplier` | **2.0** | 1.0 |
| Funding-fee event timeout | — | `fundingFeeTimeoutSeconds` | *(unset → 30)* | 30 |

> **`retracementPct = 1.0` puts the take-profit back at the anchor price** — the
> strategy waits for a full recovery to the pre-funding reference, not a partial
> retrace. The `[0.3, 0.618]` Fibonacci range in the original spec is not what the
> fleet runs.

### Execution Flow

```
1. AT T_funding - entryOffsetSeconds (live: -3s):
   → ENTRY: BUY MARKET at best ask (WS order adapter)
   → Record P_entry (fill) and anchorPrice (reference price at decision time)
   → Place STOP-LOSS: SELL STOP at P_entry × (1 − |F%| × slMultiplier / 100)

2. ON ws.funding_fee event (fallback: fundingFeeTimeoutSeconds after T_funding):
   → ARM the retracement tracker

3. WHILE tracking (polls price every 1s):
   → Maintain a running P_low (lowest price seen since arming)
   → EACH TIME P_low makes a new low:
       P_target = P_low + (anchorPrice - P_low) × retracementPct
       → CANCEL the previous TP limit and RE-PLACE SELL LIMIT at P_target
       (throttled to at most one re-place per second)

4. EXIT (whichever comes first):
   → SL hit: SELL STOP triggers (taker fee)
   → TP hit: SELL LIMIT at the current P_target (maker fee)
   → T_deadline (T_funding + 900s): SELL MARKET reduce-only (taker fee)
```

`exitPolicy.kind = 'sl_tp_deadline_retracement_funding_event'`. WS-mandatory. The
tracker is re-spawned from the database on engine recovery, so a restart mid-position
does not lose the trailing TP.

### P&L Formula

```
IF SL hit:
  DELTA_PNL = (P_SL_fill - P_entry) / P_entry
  FEES      = taker_fee × 2                      # market entry + stop-market exit
IF TP hit:
  DELTA_PNL = (P_target - P_entry) / P_entry
  FEES      = taker_fee + maker_fee              # market entry + limit exit
IF deadline exit:
  DELTA_PNL = (P_deadline - P_entry) / P_entry
  FEES      = taker_fee × 2

FUNDING_PNL = +F
NET_PNL     = DELTA_PNL + FUNDING_PNL - FEES
```

### Key Consideration — P_low Identification (resolved)

The original spec flagged this as an open problem: in live trading you cannot know
`P_low` in advance, so you cannot place a single correct retracement limit.

**The live engine solves it with a trailing take-profit rather than a one-shot limit.**
The tracker re-places the TP each time the running low makes a new low, so the TP
chases the bottom down and settles wherever the drop actually ends — no prediction
required.

Two consequences the backtester must model to stay at parity:

- The TP is only armed **after the funding-fee event**, not at `T_funding` — there is
  a window right after settlement in which only the SL is live.
- The TP price is a function of the **running minimum**, not the final `P_low`. A
  backtest that places one limit at the true `P_low`-derived target is optimistic.

---

## Strategy 3a: Negative Funding SHORT — Ride the Drop

**Status:** implemented, **not deployed** (config exists; absent from `fleet.yaml`).

**Thesis:** Instead of collecting funding (which you'd pay as a short), profit directly from the anticipated price drop. The price drop must exceed the funding fee paid.

### Parameters

| Parameter | Doc variable | Live config key | Live value | Schema default |
|---|---|---|---|---|
| Funding threshold | `F_threshold` | `negativeFundingThresholdPercent` | **−0.1** | −0.5 |
| Entry offset | `T_entry` | `entryOffsetSeconds` | **3** | 10 |
| Stop-loss | `SL` | `stopLossPercent` | **1.0** | 1.0 |
| Take-profit multiplier | `TP` | `tpVariantAMultiplier` | **1.5** (`TP = |F%| × 1.5`) | 1.5 |
| Deadline | `T_deadline` | `deadlineSeconds` | **900** | 300 |

> **`stopLossPercent` is a fixed percentage, not a multiple of the funding rate.**
> Unlike `slMultiplier` elsewhere, this SL does not scale with `F` — a 1.0% adverse
> move stops the position out regardless of how negative funding was.

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
   → T_deadline (T_funding + 900s) → BUY MARKET reduce-only, exitReason = deadline
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
strategy (`strategy_1`, `strategy_1_ws`, `strategy_2`, `strategy_4_*a`) — the two would
offset each other inside the same funding window. `strategy_6` is exempt, since its
direction is configurable.

---

## Strategy 4.1a: Negative Funding Ladder LONG — Post-Funding Entry

**Status:** deployed on all 6 exchanges.

**Thesis:** Place a ladder of limit buy orders below the current price to catch the post-funding drop, then exit at a profit target above average entry. Because the position opens *after* settlement, **no funding fee is received** — the entire edge is the delta recovery off the bottom of the drop.

### Parameters

| Parameter | Doc variable | Live config key | Live value | Schema default |
|---|---|---|---|---|
| Funding threshold | `F_threshold` | `negativeFundingThresholdPercent` | **−0.1** | −0.4 |
| Setup time | `T_setup` | `entryOffsetSeconds` | **3** | 5 |
| Ladder count | `ladder_count` | `ladderCount` | **5** | 5 (min 2) |
| Ladder top | `ladder_top_mult` | `ladderTopMult` | **0.7** | 0.5 |
| Ladder bottom | `ladder_bottom_mult` | `ladderBottomMult` | **1.8** | 1.5 |
| Take-profit | `TP` | `takeProfitPct` | **0.003** ⚠️ | 0.2 |
| Stop-loss multiplier | `sl_mult` | `slMultiplier` | **2.5** | 1.0 |
| Deadline | `T_deadline` | `deadlineSeconds` | **1800** (30 min) | 60 |

> ⚠️ **`takeProfitPct: 0.003` is very likely a unit error.** The engine computes
> `tpPrice = fill × (1 + takeProfitPct / 100)`, so this means **0.003 percent ≈ 0.3
> basis points** above the average fill — a take-profit essentially at the entry price.
> It looks like a decimal fraction (`0.003` = 0.3%) mis-ported from the backtest schema,
> where the same concept is a fraction rather than a percent. Documented here as it
> actually runs; **this is not a recommendation.** Verify against backtest intent before
> changing.

`ladderBottomMult` MUST be greater than `ladderTopMult` — enforced by the config loader.

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

4. EXIT (whichever comes first):
   → SL hit (taker fee)
   → TP hit (maker fee)
   → T_deadline → SELL MARKET reduce-only + cancel unfilled limits
```

### Ladder Mechanics (live engine)

- **Quantity distribution.** `amountUsd` is split across rungs using a
  **largest-remainder distribution** over the exchange lot step, so rounding does not
  silently lose size. Rungs are not necessarily equal in quantity.
- **Min-notional pre-check.** If even the *top* rung — at its most favourable price —
  fails the exchange's `minCost`, the symbol is skipped entirely before any order goes
  out. Individual rungs below min-notional are dropped at placement, so a ladder may go
  out with fewer than `ladderCount` orders.
- **Pre-funding fill.** A rung is *supposed* to fill after settlement. If one fills
  **before** `T_funding` the position does accrue funding, contradicting the no-funding
  premise. The engine logs `ladder.pre_funding_fill` plus an ops event and **keeps the
  position**.
- **Post-error protective close.** If a rung fills after the intent has already errored
  with `ladder_no_fills` (a cancel/fill race), a reduce-only market close is placed so
  no orphan position is left behind.

### P&L Formula

```
P_avg = sum(filled_price[i] × qty[i]) / sum(qty[i])

DELTA_PNL   = (P_exit - P_avg) / P_avg
FUNDING_PNL = 0                                  # position opens after settlement

FEES = (num_filled_limits × maker_fee) + exit_fee
  where exit_fee = maker_fee (if TP limit) or taker_fee (if SL / deadline market)

NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
```

---

## Strategy 4.2a: Negative Funding Single LONG — Post-Funding Entry

**Status:** implemented, **not deployed** — and its live config is unusable as written.

> **⚠️ The `live-configs/strategies/strategy_4_2a-<exchange>.yaml` files are written in
> the flat *backtest* schema** (`strategy_id`, `direction`, `funding_threshold`,
> `limit_offset_mult`, `take_profit`, `funding_applied_on_same_second`), not the
> execution engine's schema (a `strategies:` list of camelCase keys). The fleet config
> generator would reject them with *"produced no strategies"*. This has gone unnoticed
> because `strategy_4_2a` is absent from `fleet.yaml` and runs in no container. **These
> files must be rewritten into the execution schema before this strategy can be
> deployed.**

**Thesis:** Simplified version of 4.1a — single limit buy instead of a ladder. The position opens after settlement, so **no funding fee is received**.

### Parameters

Engine schema keys, with schema defaults. There are no valid live values to quote — see
the warning above.

| Parameter | Doc variable | Live config key | Schema default |
|---|---|---|---|
| Funding threshold | `F_threshold` | `negativeFundingThresholdPercent` | −0.4 |
| Entry offset | `T_entry` | `entryOffsetSeconds` | 5 |
| Limit offset | `limit_offset_mult` | `limitOffsetMult` | 0.75 |
| Take-profit | `TP` | `takeProfitPct` | 0.2 |
| Stop-loss multiplier | `sl_mult` | `slMultiplier` | 1.5 |
| Deadline | `T_deadline` | `deadlineSeconds` | 60 |

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

3. EXIT (whichever comes first):
   → SL hit (taker fee)
   → TP hit (maker fee)
   → T_deadline → SELL MARKET + cancel unfilled limit

4. IF never filled by T_deadline:
   → Cancel the limit; intent terminates with error code = limit_expired
     (no position, no SL/TP placed)
```

### P&L Formula

Same structure as 4.1a but with a single entry price instead of `P_avg`, and
`FUNDING_PNL = 0`.

---

## Strategy 6: Post-Funding Directional — WS-Gated Entry

**Status:** deployed on all 6 exchanges. **Live-only** — the backtest engine rejects any config containing `strategy_6`, because backtests cannot emulate private WS funding-fee events.

**Thesis:** Take a directional position whose entry is triggered by the WS `funding_fee` event — the moment funding actually accrues on the exchange. Private WS user-data streams only push events for symbols where you already hold a position, so a tiny **PRE_FUNDING order in the opposite direction** is placed before settlement purely to subscribe the symbol into the stream. The full-size **MAIN order** fires on the event and reverses that tiny position; net exposure is `mainVolume − preFundingVolume`.

> **Strategy 6 is not a negative-funding strategy.** The live fleet runs
> `mainSide: long` with `funding_threshold: +0.1` — it goes **long on positive funding
> ≥ +0.1%**, the opposite regime from every other strategy here. The bet is on the
> post-settlement directional move, not on collecting funding. Do not assume the
> negative-funding framing of Strategies 1–4 applies.

### Parameters

| Parameter | Live config key | Live value | Schema default |
|---|---|---|---|
| Trade direction | `mainSide` | **`long`** | *(required)* |
| Funding-rate threshold (signed, percent) | `funding_threshold` | **+0.1** | 0 (always-on) |
| Pre-funding entry offset | `entryOffsetSeconds` | **3** | 10 |
| WS funding-fee timeout | `fundingFeeTimeoutSeconds` | **10** (**okx: 45**) | 30 |
| TP multiplier | `tpMultiplier` | **1.5** | 0.5 |
| SL multiplier | `slMultiplier` | **1.5** | 1.0 |
| Deadline after funding | `deadlineSeconds` | **1800** (30 min) | 3300 |
| Main position size | `mainAmountUsd` | **10** | *(required)* |
| Leverage | `leverage` | **5** | *(required)* |

> `funding_threshold` is the only **snake_case** strategy key in the config schema; every
> other param is camelCase. The size key is `mainAmountUsd`, not `amountUsd`.

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

### Execution Flow (LONG example; SHORT mirrors signs)

```
1. AT T_funding - entryOffsetSeconds:
   → PRE_FUNDING_ORDER: SELL MARKET (opposite to mainSide),
     size = min possible (exchange lot floor + min-notional floor).
     This tiny SHORT subscribes the symbol to the private WS stream.

2. AWAIT ws.funding_fee for (exchange, symbol), fundingTime ≈ T_funding (±5s tolerance)
   Hard fallback at T_funding + fundingFeeTimeoutSeconds:
     → abort: MARKET-close PRE_FUNDING (reduce-only), retried up to 3× with
       250 / 1000 / 3000 ms backoff; a REST position fetch is ground truth.
     → settle as funding_event_timeout

3. ON ws.funding_fee event:
   → Confirm PRE_FUNDING actually filled (else abort + close)
   → MAIN: BUY MARKET, size = mainVolume, via WS order adapter
   → A mainEventLock guarantees MAIN fires exactly once
   Net exchange position = mainVolume − preFundingVolume LONG

4. ON MAIN fill at price P_entry:
   → Confirm net position qty via REST getPositions()
   → TP: SELL LIMIT       at P_entry × (1 + |F%| × tpMultiplier / 100)
   → SL: SELL STOP-MARKET at P_entry × (1 − |F%| × slMultiplier / 100)
   → tpPct / slPct are computed at FILL time, not decision time
   → TP/SL sized on NET qty (filledQty − preFundingVolume)
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

`FUNDING_PRE` is always negative (PRE_FUNDING is in the wrong direction). It is minimised by using the smallest possible PRE_FUNDING size.

### Profit Condition

```
MAIN_DELTA > |PRE_FUNDING_DELTA| + FUNDING_PRE + FEES
```

### Key Risks

- **WS event miss:** if `ws.funding_fee` never arrives, the timeout fires and PRE_FUNDING is closed at a small loss.
- **PRE_FUNDING funding cost:** the tiny position accrues funding in the wrong direction.
- **MAIN slippage:** MAIN is a market order fired immediately after the event; liquidity around the funding spike may be thin.
- **Ordering caveat:** the MAIN fill completes after settlement, so MAIN does **not** receive the funding fee this cycle. On exchanges that settle FIFO, the PRE_FUNDING position receives it instead.

### Error Codes

| Code | Meaning |
|---|---|
| `pre_funding_order_failed` | PRE_FUNDING order submission threw |
| `pre_funding_order_rejected` | Exchange rejected the PRE_FUNDING order |
| `pre_funding_not_filled` | WS event arrived but PRE_FUNDING never filled — MAIN is not sent |
| `funding_event_timeout` | No `ws.funding_fee` within the timeout; PRE_FUNDING closed |
| `main_order_failed` | MAIN order submission threw |
| `main_order_rejected` | Exchange rejected the MAIN order |
| `close_pre_funding_failed` | Abort path could not flatten PRE_FUNDING (all 3 retries failed) |

---

# CONSOLIDATED VARIABLE REGISTRY

## Input Variables (per funding event)

| Variable | Type | Source |
|---|---|---|
| `funding_rate` | float | Exchange API (predicted) |
| `T_funding` | datetime | Exchange funding schedule |
| `price_timeseries` | float[] | Tick/second-level OHLCV |
| `volume_24h` | float | Exchange API |
| `taker_fee` | float | Exchange fee schedule |
| `maker_fee` | float | Exchange fee schedule |

## Strategy Parameters (tunable)

| Parameter | Live config key | Used In | Type | Schema default |
|---|---|---|---|---|
| `F_threshold` | `negativeFundingThresholdPercent` | 1, 1_ws, 2, 3a, 4.1a, 4.2a | float (percent, signed) | −0.4 to −0.5 |
| `entry_offset_seconds` | `entryOffsetSeconds` | all | int | 5s (or 10s) |
| `exit_offset_seconds` | `exitOffsetSeconds` | 1 | int | 2s |
| — | `fundingFeeTimeoutSeconds` | 1_ws, 2, 6 | int | 30s |
| `retracement_pct` | `retracementPct` | 2 | float [0, 1] | 0.50 |
| `SL` | `stopLossPercent` | 3a | float (fixed percent) | 1.0% |
| `TP` | `takeProfitPct` | 4.1a, 4.2a | float (percent) | varies |
| `TP_mode` | `tpVariantAMultiplier` | 3a | float | 1.5 |
| `ladder_count` | `ladderCount` | 4.1a | int | 5 |
| `ladder_top_mult` | `ladderTopMult` | 4.1a | float | 0.5 |
| `ladder_bottom_mult` | `ladderBottomMult` | 4.1a | float | 1.5 |
| `limit_offset_mult` | `limitOffsetMult` | 4.2a | float | 0.75 |
| `sl_mult` | `slMultiplier` | 2, 4.1a, 4.2a, 6 | float | 1.0–1.5 |
| `T_deadline` | `deadlineSeconds` | 2, 3a, 4.x, 6 | int (seconds) | 60s |
| — | `mainSide` | 6 | enum `long`/`short` | *(required)* |
| — | `funding_threshold` | 6 | float (percent, **signed**) | 0 |
| — | `tpMultiplier` | 6 | float | 0.5 |

## Output Variables (per trade)

| Variable | Description |
|---|---|
| `P_entry` | Actual entry price |
| `P_exit` | Actual exit price |
| `P_avg` | Average entry price (ladder strategies) |
| `delta_pnl` | Price movement P&L (%) |
| `funding_pnl` | Funding fee P&L (%) |
| `fee_cost` | Total fees paid (%) |
| `net_pnl` | Final net P&L (%) |
| `exit_reason` | Enum: `TP_HIT`, `SL_HIT`, `DEADLINE`, `MARKET_EXIT`, `timed`, `funding_fee_event`, `funding_fee_timeout` |
| `hold_duration` | Seconds from entry to exit |
| `fill_count` | Number of limit orders filled (ladder) |
| `funding_received` | Boolean: did the position receive funding? |

---

# STRATEGY COMPARISON MATRIX

| | Direction | Entry | Exit | Profits From | Costs | Key Risk |
|---|---|---|---|---|---|---|
| **S1** | LONG | Market (−3s) | Market (+4s), timed | Funding fee | Delta drop + fees | Drop > funding |
| **S1 WS** | LONG | Market (−3s) | Market on WS funding-fee event (timeout fallback) | Funding fee | Delta drop + fees | Event delayed/missed |
| **S2** | LONG | Market (−3s) | Stop (SL), trailing Limit (retrace), or Market (deadline) | Funding fee + retrace | Residual delta + fees | No retracement; sharp drop triggers SL |
| **S3a** | SHORT | Market (−3s) | Limit (TP), Stop (SL), or Market (deadline) | Delta drop | Funding fee paid + fees | Drop < funding paid |
| **S4.1a** | LONG | Ladder limits (−3s) | Stop (SL), Limit (TP), or Market (deadline) | Delta recovery | Fees, unfilled orders | No recovery; sharp drop triggers SL |
| **S4.2a** | LONG | Single limit | Stop (SL), Limit (TP), or Market (deadline) | Delta recovery | Fees | Not filled, or sharp drop triggers SL |
| **S6** | LONG or SHORT | Pre-fund opposite (tiny) + MAIN market on WS event | TP Limit / SL Stop-Market / Deadline | Directional move post-funding | 2 entries + 1 exit fees + PRE_FUNDING funding cost | WS event miss; MAIN slippage; thin liquidity |

---

# BACKTESTING DATA REQUIREMENTS

## Minimum Data

1. **Tick-level or 1-second candle data** around each funding event (at least `[T_funding - 60s, T_funding + 120s]`)
2. **Predicted funding rate** at each funding interval
3. **Exchange fee schedule** (maker/taker)

## Ideal Data

4. **Trade-by-trade data** (for precise fill simulation)

## Backtesting Considerations

- **No funding for Strategies 4.x:** the price drop occurs at the funding timestamp and limit orders fill during and after it, so the position opens *after* settlement and receives no funding fee. Model `FUNDING_PNL = 0`. The one exception is a ladder rung filling *before* `T_funding` — the live engine keeps such a position, and it *does* accrue funding.
- **Partial fills:** the 4.1a ladder may only partially fill. The backtester must track per-order fills.
- **Strategy 2 trailing TP:** the TP is re-placed as the running low makes new lows, and is only armed after the funding-fee event. A backtest that places one limit at the true `P_low`-derived target is optimistic.
- **Strategy 6 cannot be backtested:** its MAIN entry depends on a private WS `funding_fee` event that backtests cannot emulate.
- **Order placement latency:** a realistic backtester should account for 50–200ms network latency for order placement.
- **Exchange clock synchronization:** entry at `T_funding − entryOffsetSeconds` assumes accurate clock sync with the exchange.

---

# LIVE ENGINE BEHAVIOR

Engine-level guards that are not YAML parameters but materially change which trades are
taken. See `docs-strategy/strategies/_globals.md` for the full treatment.

- **Scheduler pre-filter:** only symbols within **0.1 pp** of an enabled threshold get an evaluation timer; snapshots older than 30s are skipped; candidates are ordered **most-negative funding first**.
- **Risk caps:** `maxConcurrentIntents: 200`, `maxNotionalUsd: 50000` per container. **Smart preemption** cancels the least-negative-funding non-monitoring intent to make room for a better one.
- **WS-mandatory order path** for `strategy_1_ws`, `strategy_2`, `strategy_6`. OKX falls back to REST on `WS_TIMEOUT`.
- **Submission stagger:** bybit 150ms, binance 100ms.
- **Fallbacks:** REST fill-poll on WS miss; REST funding-fee poll; orphan-position auto-flatten; stale reduce-only sweep before entry.
- **Kill switch:** `off` / `paused` / `flatten`. Non-`off` rejects every new intent before any exchange API call.
