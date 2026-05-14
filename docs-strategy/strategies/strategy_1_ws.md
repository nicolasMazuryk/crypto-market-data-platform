# Strategy 1 WS — WebSocket Funding-Fee Exit

This is the live-execution variant of Strategy 1. It keeps the same entry thesis as
Strategy 1, but replaces the fixed `T_funding + 2s` exit with a private WebSocket
funding-fee event gate.

---

## Strategy 1 WS: Negative Funding LONG — Funding-Fee Event Exit

**Thesis:** Collect negative funding by holding a long through settlement, then exit
as soon as the exchange confirms the funding fee on the private stream. This aims to
minimize post-settlement delta exposure without exiting before funding is actually
credited.

### Parameters

| Parameter | Variable | Default |
|---|---|---|
| Funding threshold | `F_threshold` | 0.4% |
| Entry offset | `T_entry` | `T_funding - 5s` |
| Funding-fee event timeout | `T_timeout` | strategy config |

### Selection Logic

```
IF current_time == T_funding - 5s
AND predicted_funding_rate < -F_threshold
THEN trigger strategy
```

### Execution Flow

```
1. AT T_funding - 5s:
   -> ENTRY: BUY MARKET at best ask

2. AFTER T_funding:
   -> WAIT for private WebSocket funding-fee event for the same exchange and symbol

3. ON funding-fee event:
   -> EXIT: SELL MARKET reduce-only at best bid

4. IF no funding-fee event arrives before timeout:
   -> EXIT: SELL MARKET reduce-only using the timeout fallback
```

### Difference From Strategy 1

Strategy 1 exits at a fixed timestamp: `T_funding + 2s`.

Strategy 1 WS exits when the private account stream reports the funding-fee event.
The exit time can be earlier or later than `T_funding + 2s`, depending on exchange
event timing, WebSocket latency, reconnect behavior, and the configured timeout.

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
- Backtests using fixed `T_funding + 2s` exits are not parity for this variant unless
  private funding-fee event timing is modeled.

### P&L Formula

```
DELTA_PNL   = (P_exit_ws - P_entry) / P_entry
FUNDING_PNL = +F
FEES        = taker_fee * 2

NET_PNL = DELTA_PNL + FUNDING_PNL - FEES
```
