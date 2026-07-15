# Strategy 1 WS — WebSocket Funding-Fee Exit

This is the live-execution variant of Strategy 1. It keeps the same entry thesis as
Strategy 1, but replaces the fixed `T_funding + 2s` exit with a private WebSocket
funding-fee event gate.

---

## Strategy 1 WS: Negative Funding LONG — Funding-Fee Event Exit

**Status:** deployed on all 6 exchanges.

**Thesis:** Collect negative funding by holding a long through settlement, then exit
as soon as the exchange confirms the funding fee on the private stream. This aims to
minimize post-settlement delta exposure without exiting before funding is actually
credited.

### Parameters

| Parameter | Doc variable | Live config key | Live value | Schema default |
|---|---|---|---|---|
| Funding threshold | `F_threshold` | `negativeFundingThresholdPercent` | **−0.1** | −0.5 |
| Entry offset | `T_entry` | `entryOffsetSeconds` | **3** (`T_funding − 3s`) | 10 |
| Funding-fee event timeout | `T_timeout` | `fundingFeeTimeoutSeconds` | **10** (**okx: 45**) | 30 |
| Notional | — | `amountUsd` | 10 | 20 |
| Leverage | — | `leverage` | 5 | 4 |

> **OKX runs a 45s timeout** rather than 10s, because its private funding-fee event
> is materially slower to arrive. Setting it to 10s there would cause routine false
> timeouts.

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
   -> ENTRY: BUY MARKET at best ask (placed over the WS order adapter)

2. AFTER T_funding:
   -> WAIT for private WebSocket funding_fee event for the same exchange and symbol.
      The event's fundingTime must match T_funding within +/- 5s to be accepted.

3. ON funding-fee event:
   -> EXIT: SELL MARKET reduce-only at best bid
   -> exitReason = funding_fee_event

4. IF no funding-fee event arrives within fundingFeeTimeoutSeconds after T_funding:
   -> EXIT: SELL MARKET reduce-only (timeout fallback)
   -> exitReason = funding_fee_timeout
```

`exitPolicy.kind = 'funding_fee_event'`.

### Difference From Strategy 1

Strategy 1 exits at a fixed offset: `T_funding + exitOffsetSeconds`.

Strategy 1 WS exits when the private account stream reports the funding-fee event.
The exit time can be earlier or later than Strategy 1's fixed exit, depending on
exchange event timing, WebSocket latency, reconnect behavior, and the configured
timeout.

### WS-Miss Safety Net

The WS event is not the only detection path. A **REST funding-fee poll** fires at
`T_funding + 3s` with an **8s grace period**; if it observes the funding credit
before the WS event arrives, it opens the funding gate and the exit proceeds
normally. The `fundingFeeTimeoutSeconds` fallback is the last resort behind that.

Order placement for this strategy is **WS-mandatory** — the engine throws at startup
if no WS order adapter is available. OKX (and only OKX) falls back to REST on
`WS_TIMEOUT`.

Observability: `intent.funding_gate_opened` / `intent.funding_gate_closed`.

Code references: `src/execution/execution/monitor.ts` (funding gate, REST poll),
`src/execution/strategies/strategy_1_ws.ts`.

### Assumptions

- The private WebSocket account stream emits funding-fee events reliably and with
  enough symbol and funding-time context to match the open intent.
- Funding is credited before or at the time the event is observed.
- The timeout fallback is long enough to avoid routine false timeouts, but short
  enough to cap delta exposure if the private stream is delayed or disconnected.
- The reduce-only close path remains available if the WebSocket order path rejects
  or times out.

### Risks

- A delayed or missing private event extends holding time until the timeout fallback.
- A false or mismatched funding-fee event can close earlier than intended.
- WebSocket order rejection requires immediate REST reduce-only fallback.
- Backtests using a fixed post-funding exit are not parity for this variant unless
  private funding-fee event timing is modeled.

### P&L Formula

```
DELTA_PNL   = (P_exit_ws - P_entry) / P_entry
FUNDING_PNL = +F
FEES        = taker_fee * 2

NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
```
