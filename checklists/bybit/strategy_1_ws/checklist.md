# Checklist — bybit / strategy_1_ws

Exchange: **bybit**
Strategy: **strategy_1_ws** (Negative Funding LONG — Funding-Fee Event Exit)
Spec: `docs-strategy/strategies/strategy_1_ws.md`
Code: `src/execution/strategies/strategy_1_ws.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/bybit.ts`, `src/execution/adapters/privatews/bybit-mapping.ts`

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────


- id: strategy_1_ws.bybit.ORDER_LIFECYCLE.ENTRY_PARTIAL_THEN_FULL_FILL
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Entry market order partially fills (PartiallyFilled) then fills fully (Filled).
    Manager logs intermediate partially_filled state, then fill completes normally
    and monitor arms with funding_fee_event policy.
  preconditions:
    - entry order in status=working
    - Bybit emits PartiallyFilled then Filled order events
  trigger_sequence:
    - Bybit WS: {topic: "order", data: [{orderStatus: "PartiallyFilled"}]}
    - Bybit WS: {topic: "order", data: [{orderStatus: "Filled"}]}
  expected_behavior:
    - status transitions working → partially_filled (on partial)
    - status transitions partially_filled → filled (on full fill)
    - order.filled logged once on Filled event
    - monitor armed (funding_fee_event)
  observability_contract:
    - db:intentLifecycleEvents working→partially_filled then partially_filled→filled
    - log: 'order.filled' {filledQty: "total qty"}
    - log: 'monitor.armed.funding_fee_event' {fundingTs}
  code_refs:
    - src/execution/adapters/privatews/bybit-mapping.ts:66 (mapBybitOrderStatus)
    - src/execution/execution/manager.ts:1159 (partially_filled transition)
    - src/execution/execution/manager.ts:1156 (FILLED order.filled)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_1_ws.bybit.ORDER_LIFECYCLE.ENTRY_WS_ADAPTER_MISSING
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    No WS order adapter registered for bybit. orderClient() throws immediately.
    Intent enters error state. No REST fallback for entry.
  preconditions:
    - opts.orderWsAdapters has no entry for 'bybit'
  trigger_sequence:
    - orderClient('bybit', 'strategy_1_ws') throws Error
  expected_behavior:
    - intent enters error state
    - no order.placed
  observability_contract:
    - log: 'intent.error' {code: "create_order_failed" or thrown error}
    - db:intentLifecycleEvents →error
  code_refs:
    - src/execution/execution/manager.ts:97 (requiresWsOrderAdapter check)
    - src/execution/execution/manager.ts:100 (throw if missing)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: rare

- id: strategy_1_ws.bybit.ORDER_LIFECYCLE.CLOSE_WS_REJECTED_REST_FALLBACK
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Monitor exit fires. Close order placed via WS adapter returns status=rejected.
    Because requiresWsOrderAdapter=true, manager logs close.ws_rejected and retries
    via REST createOrder. REST close placed successfully.
  preconditions:
    - intent in status=monitoring
    - WS adapter returns rejected ACK for close order
  trigger_sequence:
    - monitor.settle → handleMonitorExit
    - WS adapter createOrder returns {status: 'rejected'}
    - REST createOrder called as fallback
  expected_behavior:
    - close.ws_rejected logged (error level) with rejectReason
    - order.placed logged (kind=close, side=sell, orderType=market, reduceOnly=true)
    - intent transitions to exited
  observability_contract:
    - log: 'close.ws_rejected' {rejectReason}  # error level
    - log: 'order.placed' {kind: "close", side: "sell", orderType: "market", reduceOnly: true}
    - db:orders {kind: "close", status: "filled"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/manager.ts:1620 (ws_rejected check)
    - src/execution/execution/manager.ts:1622 (close.ws_rejected log)
    - src/execution/execution/manager.ts:1625 (REST fallback)
    - src/execution/execution/manager.ts:1660 (order.placed log)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────




- id: strategy_1_ws.bybit.TIMING.ENTRY_FILL_REST_POLL_FALLBACK
  category: TIMING
  severity: high
  description: >
    WS fill event for entry order not received. REST poll fallback (15 polls × 1s)
    detects fill via getOrder. Drives intent to filled → monitoring. WS is primary
    on Bybit; poll is safety net.
  preconditions:
    - entry order placed (status=working)
    - WS fill event not received
  trigger_sequence:
    - pollForEntryFill loop: getOrder returns status=filled
  expected_behavior:
    - order.filled logged (from poll)
    - status working → filled → monitoring
    - monitor armed (funding_fee_event)
  observability_contract:
    - log: 'order.filled' (from poll)
    - log: 'position.opened'
    - db:intentLifecycleEvents working→filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:1179 (pollForEntryFill)
    - src/execution/execution/manager.ts:2787 (poll started after ACK)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_1_ws.bybit.WEBSOCKET.RECONNECT_TRIGGERS_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    Bybit private WS disconnects and reconnects while intent is in monitoring.
    store.reconcile() called on reconnect. funding_fee_event monitor remains armed.
    No duplicate exit triggered.
  preconditions:
    - intent in status=monitoring
    - WS disconnects then reconnects
  trigger_sequence:
    - ws.connection {state: "disconnected"} then {state: "connected"}
  expected_behavior:
    - store.reconcile() called (REST fetch of orders/positions)
    - monitor NOT re-armed by reconnect
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal)
    - log: event='ws.connection' {exchange: "bybit", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - position balance consistent after reconcile
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (reconcile on reconnect)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_1_ws.bybit.WEBSOCKET.FUNDING_FEE_WRONG_SYMBOL_IGNORED
  category: WEBSOCKET
  severity: medium
  description: >
    Bybit emits execution event with execType=Funding for a different symbol.
    Monitor bus listener receives ws.funding_fee but symbol filter rejects it.
    Intent stays in monitoring.
  preconditions:
    - intent in monitoring for symbol X
    - Bybit emits execution.Funding for symbol Y
  trigger_sequence:
    - bus: 'ws.funding_fee' {exchange: "bybit", symbol: "Y"}
    - monitor: event.symbol !== intent.symbol → return (ignored)
  expected_behavior:
    - NO monitor.settle logged
    - intent status remains monitoring
  observability_contract:
    - NO log: 'monitor.settle' for this event
    - NO log: 'intent.exiting.start'
  code_refs:
    - src/execution/execution/monitor.ts:200 (symbol filter)
    - src/execution/execution/monitor.ts:201 (timestamp tolerance filter)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional


# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_1_ws.bybit.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarted while intent in monitoring. Recovery rehydrates from DB.
    monitor.arm() re-creates timeout timer and ws.funding_fee bus listener.
    If timeoutAt not yet elapsed, timer fires at timeoutAt - now. If elapsed, fires immediately.
  preconditions:
    - intent in DB with status=monitoring, exitPolicy.kind=funding_fee_event
  trigger_sequence:
    - process restart → runRecovery → manager.start → monitor.arm
  expected_behavior:
    - recovery: rehydrated intent states logged
    - monitor.armed.funding_fee_event logged (debug)
    - exit triggered via funding_fee or funding_fee_timeout
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.funding_fee_event' {timeoutDelay: ">=0"}
    - log: 'intent.exiting.start' {reason: "funding_fee" or "funding_fee_timeout"}
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated log)
    - src/execution/execution/manager.ts:1888 (start re-arm)
    - src/execution/execution/monitor.ts:183 (funding_fee_event arm)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_1_ws.bybit.RECOVERY.RESTART_TIMEOUT_ALREADY_PAST
  category: RECOVERY
  severity: high
  description: >
    Process restarts after timeoutAt elapsed. Monitor arms with timeoutDelay=0.
    Timer fires immediately → settle(funding_fee_timeout). Close placed right away.
  preconditions:
    - intent in monitoring, now > timeoutAt
  trigger_sequence:
    - runRecovery → monitor.arm → timeoutDelay=0 → immediate settle
  expected_behavior:
    - monitor.armed.funding_fee_event {timeoutDelay: 0}
    - monitor.settle {reason: funding_fee_timeout, source: timer}
    - intent.exiting.start immediately
  observability_contract:
    - log: 'monitor.armed.funding_fee_event' {timeoutDelay: 0}
    - log: 'monitor.settle' {reason: "funding_fee_timeout", source: "timer"}
    - log: 'intent.exiting.start' {reason: "funding_fee_timeout"}
  code_refs:
    - src/execution/execution/monitor.ts:188 (Math.max(0, timeoutAt - now - skewMs))
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

# ── STRATEGY_SPECIFIC ────────────────────────────────────────────────────────

- id: strategy_1_ws.bybit.STRATEGY_SPECIFIC.WS_ADAPTER_REQUIRED_NO_REST_FALLBACK_FOR_ENTRY
  category: STRATEGY_SPECIFIC
  severity: critical
  description: >
    Entry placement on Bybit always uses WS adapter. No REST fallback if WS entry
    fails or throws. REST fallback exists only for close order (ws_rejected case).
  preconditions:
    - WS adapter registered for bybit but createOrder throws
  trigger_sequence:
    - orderClient returns WS adapter → createOrder throws → setError
  expected_behavior:
    - intent.error (no order placed, no REST retry for entry)
  observability_contract:
    - log: 'intent.error' {code: "create_order_failed"}
  code_refs:
    - src/execution/execution/manager.ts:90 (requiresWsOrderAdapter)
    - src/execution/execution/manager.ts:97 (WS adapter path, no REST fallback for entry)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: rare


# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_1_ws.bybit.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active blocks strategy_1_ws intent before any order reaches Bybit.
    intent.error with code=kill_switch logged.
  preconditions:
    - kill switch mode != 'off'
    - strategy condition met
  trigger_sequence:
    - manager.submit() → preflight → kill switch rejects
  expected_behavior:
    - intent.created logged
    - intent.error {code: "kill_switch"}
    - no order.placed
  observability_contract:
    - log: 'intent.error' {code: "kill_switch"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:intentLifecycleEvents decided→error
  code_refs:
    - src/execution/execution/preflight.ts:32 (kill switch check)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_1_ws.bybit.SPEC_DIVERGENCE.NO_REF_PRICE_EARLY_REJECT
  category: SPEC_DIVERGENCE
  severity: medium
  description: >
    No ref price available at submit time (price feed stale). Intent rejected with
    code=no_ref_price before any order is sent to Bybit.
  preconditions:
    - refPrice returns undefined for symbol at submit time
  trigger_sequence:
    - manager.submit() → price undefined → setError no_ref_price
  expected_behavior:
    - intent.error {code: "no_ref_price"}
    - no order.placed
  observability_contract:
    - log: 'intent.error' {code: "no_ref_price"}
    - db:intentLifecycleEvents decided→error
  code_refs:
    - src/execution/execution/manager.ts:2012 (price undefined check)
    - src/execution/execution/manager.ts:2013 (setError no_ref_price)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: rare
```
