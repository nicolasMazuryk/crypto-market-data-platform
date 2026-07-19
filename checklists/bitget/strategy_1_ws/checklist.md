# Checklist — bitget / strategy_1_ws

Exchange: **bitget**
Strategy: **strategy_1_ws** (Negative Funding LONG — Funding-Fee Event Exit)
Spec: `docs-strategy/strategies/strategy_1_ws.md`
Code: `src/execution/strategies/strategy_1_ws.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/bitget.ts`

---

**Bitget-specific notes:**

- WS entry via WS order adapter (requiresWsOrderAdapter=true)
- Bitget WS 'orders' channel for fill events; timestamps in ms (no conversion needed)
- Bitget echoes `clientOrderId` in WS fill events → WS routing is primary
- Funding fee: Bitget account/position WS channel for funding event
- `cancelIgnoreCode`: Bitget-specific order-not-found code
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_1_ws.bitget.ORDER_LIFECYCLE.ENTRY_PLACED_VIA_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. orderClient() resolves to WS
    adapter (requiresWsOrderAdapter=true). A market BUY is placed via WS adapter.
    No clientOrderId transformation on Bitget. Bitget echoes clientOrderId in WS
    fills → WS routing is primary. pollForEntryFill started as backup.
    ws.funding_fee bus listener registered (for exit). timeoutHandle set at timeoutAt.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - WS order adapter available for bitget
  trigger_sequence:
    - scheduler fires at entryAt → manager.submit() → WS adapter createOrder
    - pollForEntryFill started (backup)
    - Bitget account listener registered (for funding fee)
    - timeoutHandle set at timeoutAt
  expected_behavior:
    - intent.created logged (strategy=strategy_1_ws, exchange=bitget)
    - order.placed (kind=entry, side=buy, orderType=market) logged
    - status decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_1_ws", exchange: "bitget"}
    - log: 'order.placed' {kind: "entry", side: "buy", orderType: "market"}
    - db:orders {kind: "entry", status: "pending"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:90 (requiresWsOrderAdapter)
    - src/execution/execution/manager.ts:96 (orderClient → WS adapter)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_1_ws.bitget.ORDER_LIFECYCLE.ENTRY_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Bitget WS 'orders' channel emits fill event with clientOrderId (ms timestamp).
    byEntryOrderId lookup succeeds. handleEntryFilled → position.opened + monitor
    armed for funding_fee_event. TERMINAL guard prevents double-processing from
    pollForEntryFill.
  preconditions:
    - entry order placed (working), Bitget WS connected
  trigger_sequence:
    - Bitget WS: orders {clientOrderId: <id>, status: "full-fill"}
    - byEntryOrderId lookup → handleEntryFilled
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice)
    - position.opened logged (side=long)
    - monitor.armed.funding_fee_event logged (debug)
    - status working → filled → monitoring
  observability_contract:
    - log: 'order.filled' {exchange: "bitget", filledQty: ">0"}
    - log: 'position.opened' {side: "long"}
    - log: 'monitor.armed.funding_fee_event' (debug)
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:1140 (handleEntryOrderEvent)
    - src/execution/execution/manager.ts:782 (position.opened)
    - src/execution/execution/monitor.ts:210 (monitor.armed.funding_fee_event)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_1_ws.bitget.ORDER_LIFECYCLE.CLOSE_WS_REJECTED_REST_FALLBACK
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Monitor exit fires. WS adapter returns rejected for close order. Manager logs
    close.ws_rejected and retries via REST createOrder. REST close succeeds.
  preconditions:
    - intent in monitoring, WS adapter rejects close order
  trigger_sequence:
    - monitor.settle → handleMonitorExit → WS adapter → {status: 'rejected'}
    - REST fallback createOrder
  expected_behavior:
    - close.ws_rejected logged (error)
    - REST close placed (kind=close, side=sell, reduceOnly=true)
  observability_contract:
    - log: 'close.ws_rejected' {rejectReason}
    - log: 'order.placed' {kind: "close"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/manager.ts:1620 (ws_rejected check)
    - src/execution/execution/manager.ts:1625 (REST fallback)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_1_ws.bitget.TIMING.FUNDING_FEE_EVENT_EXIT
  category: TIMING
  severity: critical
  description: >
    At T_f, Bitget emits a funding fee credit event on the account/position WS channel.
    Adapter maps to ws.funding_fee on the bus. Monitor listener matches by exchange,
    symbol, and ±5000ms timestamp tolerance. settle('funding_fee') fires. Market close placed.
  preconditions:
    - intent in monitoring, Bitget account funding event received at T_f
  trigger_sequence:
    - Bitget WS: account/position {fundingFee, symbol, fundingTime}
    - adapter → bus.emit('ws.funding_fee', {exchange: "bitget", symbol, fundingTime})
    - monitor listener matches → settle('funding_fee')
  expected_behavior:
    - monitor.exit_requested logged
    - monitor.settle {reason: "funding_fee", source: "ws"} logged
    - close order placed (kind=close, side=sell, reduceOnly=true)
  observability_contract:
    - log: 'monitor.exit_requested' {reason: "funding_fee"}
    - log: 'monitor.settle' {reason: "funding_fee", source: "ws", latencyMs: "<5000"}
    - log: 'order.placed' {kind: "close", side: "sell"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/adapters/privatews/bitget.ts (account funding handler)
    - src/execution/execution/monitor.ts:198 (bus.on ws.funding_fee)
    - src/execution/execution/monitor.ts:200 (±5000ms tolerance)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_1_ws.bitget.TIMING.FUNDING_FEE_TIMEOUT
  category: TIMING
  severity: high
  description: >
    ws.funding_fee not received before timeoutAt. Timeout fires. settle('funding_fee_timeout').
    Market close placed.
  preconditions:
    - intent in monitoring, ws.funding_fee not received
  trigger_sequence:
    - setTimeout at timeoutAt fires → settle('funding_fee_timeout')
  expected_behavior:
    - monitor.settle {reason: "funding_fee_timeout", source: "timer"} logged
    - close order placed
  observability_contract:
    - log: 'monitor.settle' {reason: "funding_fee_timeout", source: "timer"}
    - log: 'order.placed' {kind: "close"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:188 (timeout timer)
    - src/execution/execution/monitor.ts:190 (settle funding_fee_timeout)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_1_ws.bitget.WEBSOCKET.RECONNECT_TRIGGERS_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    Bitget WS disconnects and reconnects while intent is in monitoring.
    store.reconcile called. ws.funding_fee bus listener survives reconnect.
  preconditions:
    - intent in monitoring, Bitget WS disconnects and reconnects
  trigger_sequence:
    - ws.connection {state: "connected"} → store.reconcile('bitget')
  expected_behavior:
    - REST getOpenOrders + getPositions fetched
    - ws.funding_fee bus listener still active
    - no duplicate exit
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal)
    - log: event='ws.connection' {exchange: "bitget", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - position consistent after reconcile
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_1_ws.bitget.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_1_ws intent is in monitoring on Bitget. Recovery
    rehydrates IntentState. manager.start() re-arms funding_fee_event monitor.
    If timeoutAt past: fires immediately.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=funding_fee_event
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor.armed.funding_fee_event logged with new timeoutDelay
    - if timeoutAt past: settle('funding_fee_timeout') immediately
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.funding_fee_event' {timeoutDelay: ">=0"}
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated states)
    - src/execution/execution/manager.ts:1888 (re-arm)
    - src/execution/execution/monitor.ts:183 (funding_fee_event arm)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_1_ws.bitget.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No Bitget WS call.
  preconditions:
    - kill switch mode != 'off', strategy_1_ws condition for bitget
  trigger_sequence:
    - manager.submit() → preflight → kill_switch
  expected_behavior:
    - intent.error {code: "kill_switch"}, no order.placed
  observability_contract:
    - log: 'intent.error' {code: "kill_switch"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:intentLifecycleEvents decided→error
  code_refs:
    - src/execution/execution/preflight.ts:32
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional
```
