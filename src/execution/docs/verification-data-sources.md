# Verification Data Sources

Contract between the execution engine and the downstream verifier agent.
After each funding event, the verifier queries these sources to mark checklist scenarios ✅/⏳/❌.

| Category | Postgres | Log event (journald) | Prometheus metric |
|---|---|---|---|
| ORDER_LIFECYCLE | `orders`, `fills`, `fills_dead_letter` | `fill.unmatched`, `preflight.rejected` | `rest_orders_total`, `persistence_dropped_total` |
| TIMING | `intent_lifecycle_events` (latency_ms, context), `exit_triggers` (latency_ms, context) | — | — |
| OCO | — | `oco.cancel.start`, `oco.cancel.attempt` (strategy A/B/C), `oco.cancel.success`, `oco.cancel.exhausted`, `oco.sweep.complete` (foundOrderIds, failedCount) | — |
| WEBSOCKET | — | `ws.connection` (state, prevState, downtimeMs) | `ws_reconnect_total` |
| FUNDING_GATE | — | `intent.funding_gate_opened`, `intent.funding_gate_closed` (openedAt, closedAt, durationMs, reason) | — |
| RECOVERY | `ops_events` WHERE event_type IN ('recovery.orphan_order_cancelled', 'recovery.orphan_order_cancel_failed', 'recovery.orphan_position_flattened', 'recovery.orphan_position_flatten_failed', 'recovery.exchange_fetch_failed') | — | `recovery_orphans_cancelled_total`, `recovery_orphans_flattened_total` |
| STRATEGY_SPECIFIC | `orders` WHERE kind='pre_funding' (s6), `intent_lifecycle_events`, `funding_attributions.intent_id` | — | — |
| WAL_DURABILITY | — | `persistence.wal.discarded` (table, pgErrorCode, pgErrorText) | — |

## Journald query pattern

```bash
journalctl -u execution --output=json --since '4h ago' | jq 'select(.event=="<event_name>")'
```

## Key guarantees

- Every `fills` row goes through the queue + WAL fallback (queued, not fire-and-forget).
- `fills_dead_letter` captures any fill whose order was not found; always paired with a `fill.unmatched` log.
- `intent_lifecycle_events.latency_ms` = ms since previous state transition for this intent.
- `intent_lifecycle_events.context` = `{reason}` on exiting/exited, `{code, message}` on error.
- `exit_triggers.context` = `{source, triggerEvent, exitOrderClientId?}`.
- `funding_attributions.intent_id` resolved at insert time from open intents by (exchange, symbol, fundingTime).
- `ws.connection` log emitted on every connection state change with `prevState` and `downtimeMs` (ms of downtime, non-null only on reconnect to connected transition).
- Recovery `opsEvents.eventType` uses locked vocabulary prefixed with `recovery.`.
- `intent.funding_gate_opened/closed` emitted by `spawnRetracementTracker` only (strategy_2 and retracement-variant strategies). Strategy_6 gates MAIN entry on `ws.funding_fee` bus event — no gate log emitted there.

## OCO cancel event sequence

`cancelSiblingExit` emits in order:
1. `oco.cancel.start` — cancel attempt begins
2. `oco.cancel.attempt {strategy: "A"|"B"|"C"}` — per-strategy attempt
3. `oco.cancel.already_gone` (if exchange returns not-found) OR `oco.cancel.strategy_failed` (if still open after cancel)
4. `oco.cancel.success {strategy: "A"|"B"|"C"}` — order confirmed gone
   OR `oco.cancel.exhausted` — all three strategies failed (order may remain on exchange)
