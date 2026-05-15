# Checklist — okx / strategy_4_2a

Exchange: **okx**
Strategy: **strategy_4_2a** (Negative Funding Single Limit LONG — Post-Funding Entry)
Spec: `docs-strategy/strategies/strategy_4_2.md`
Code: `src/execution/strategies/strategy_4_2a.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_4_2a.okx.ORDER_LIFECYCLE.LIMIT_ENTRY_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - entryOffsetSeconds (default 5s). Preflight passes.
    setLeverage succeeds. A limit BUY order is placed via REST createOrder at price
    P_current × (1 - priceOffsetPct/100). canonicalize() strips dashes from the
    clientOrderId for OKX before registration in byEntryOrderId. The limit sits below
    current price, intended to fill during the post-funding price drop. expireAt=deadlineAt.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent (default -0.6%)
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - market status = trading
    - refPrice available
  trigger_sequence:
    - scheduler: evaluator fires at entryAt = nextFundingTimestamp - entryOffsetSeconds * 1000
    - manager.submit() → limit entry branch
  expected_behavior:
    - intent.created logged (strategy=strategy_4_2a, exchange=okx)
    - intent.submitted logged (entryKind=limit)
    - clientOrderId dash-stripped by canonicalize() before byEntryOrderId registration
    - order.placed (limit) logged with limitPrice and qty
    - status transitions decided → submitted → acked → working
    - expiry timer armed at delayToExpiry = deadlineAt - now
    - pollForEntryFill REST poll started (15×1s)
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_4_2a", exchange: "okx"}
    - log: 'intent.submitted' {entryKind: "limit"}
    - log: 'order.placed (limit)' {intentId, limitPrice, qty}
    - db:orders row {kind: "entry", orderType: "limit", reduceOnly: false, status: "pending"}
    - db:intentLifecycleEvents transitions decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:130 (canonicalize — strips dashes for OKX)
    - src/execution/execution/manager.ts:2546 (limit entry path begins)
    - src/execution/execution/manager.ts:2552 (limitPrice calculation)
    - src/execution/execution/manager.ts:2578 (createOrder call)
    - src/execution/execution/manager.ts:2619 (order.placed (limit) log)
    - src/execution/execution/manager.ts:2625 (expiry timer setup)
    - src/execution/execution/manager.ts:2649 (pollForEntryFill start)
    - src/execution/strategies/strategy_4_2a.ts:64 (entryPolicy limit, expireAt=deadlineAt)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (Entry Policy — limit order at T_f - 5s)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX limit order sits below market; should not fill immediately. OKX clientOrderId
    max 32 chars alphanumeric — UUID stripped of dashes = 32 chars exactly.
    Unlike strategy_1 (market), this order rests in the book and may expire unfilled.

- id: strategy_4_2a.okx.ORDER_LIFECYCLE.LIMIT_FILLS_AFTER_FUNDING
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    After T_funding, price drops to the limit level and the resting limit BUY fills.
    OKX 'orders' WS channel emits state=filled with dash-stripped clOrdId. Manager
    routes via byEntryOrderId lookup, logs order.filled, transitions to filled, then
    handleEntryFilled places SL+TP and arms the deadline monitor. pollForSlTpFill started.
  preconditions:
    - entry limit order in status=working
    - OKX WS connected
    - price drops to limit level after T_f
  trigger_sequence:
    - OKX WS: 'orders' {state: "filled", clOrdId: <stripped-clientOrderId>, avgPx: <price>}
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice=limit price)
    - status transitions working → filled → monitoring
    - position.opened logged (side=long)
    - SL (stop_market, sell) + TP (limit, sell) placed via REST
    - monitor.armed.sl_tp_deadline logged (debug)
    - pollForSlTpFill started (15s×50)
  observability_contract:
    - log: 'order.filled' {exchange: "okx", filledQty: ">0", avgFillPrice: "<limitPrice>"}
    - log: 'position.opened' {side: "long"}
    - log: 'order.placed' {kind: "sl", side: "sell", orderType: "stop_market"}
    - log: 'order.placed' {kind: "tp", side: "sell", orderType: "limit"}
    - log: 'monitor.armed.sl_tp_deadline' (debug)
    - db:intentLifecycleEvents working→filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:130 (canonicalize lookup)
    - src/execution/execution/manager.ts:1140 (handleEntryOrderEvent fill branch)
    - src/execution/execution/manager.ts:1155 (order.filled log)
    - src/execution/execution/manager.ts:406 (handleEntryFilled sl_tp_deadline)
    - src/execution/execution/manager.ts:784 (pollForSlTpFill start)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (Fill after funding → SL+TP)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX avgPx carries the average fill price. OKX limit order fill on the 'orders'
    channel includes clOrdId = dash-stripped form.

- id: strategy_4_2a.okx.ORDER_LIFECYCLE.LIMIT_EXPIRES_UNFILLED
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Expiry timer fires at deadlineAt without the limit order having filled. Manager
    cancels the unfilled limit order (REST cancelOrder with stripped clientOrderId)
    and logs 'limit.order_expired'. Intent transitions to error (no position opened).
  preconditions:
    - entry limit order in status=working, unfilled
    - clock.now() >= deadlineAt
  trigger_sequence:
    - expiry setTimeout fires at deadlineAt - now
    - cancelOrder(strippedClientOrderId)
    - setError(s, 'limit_order_expired')
  expected_behavior:
    - 'limit.order_expired' or similar warn logged
    - cancelOrder called on OKX for the limit entry
    - intent.error logged with code=limit_order_expired
    - no SL/TP placed, no position.opened
  observability_contract:
    - log: 'limit.order_expired' {intentId}  # warn level
    - log: 'intent.error' {code: "limit_order_expired"}
    - db:intentLifecycleEvents working→error
  code_refs:
    - src/execution/execution/manager.ts:2625 (expiry timer setup)
    - src/execution/execution/manager.ts:2635 (expiry callback: cancelOrder + setError)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (Expiry — cancel if unfilled)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Common when the post-funding price drop is shallower than the limit offset.
    OKX cancelOrder uses the stripped clientOrderId.

- id: strategy_4_2a.okx.ORDER_LIFECYCLE.LIMIT_FILL_POLL_FALLBACK
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    OKX WS 'orders' fill event for the limit entry does not arrive. pollForEntryFill
    (15×1s REST) detects the fill via getOrder and drives the intent to filled→monitoring.
  preconditions:
    - entry limit order placed (status=working)
    - OKX WS fill event missed or delayed
  trigger_sequence:
    - pollForEntryFill: getOrder returns status=filled
  expected_behavior:
    - order.filled logged (from poll path)
    - SL+TP placed, monitor armed
  observability_contract:
    - log: 'order.filled' (no prior WS fill log for this intentId)
    - log: 'order.placed' {kind: "sl"} and {kind: "tp"}
    - log: 'monitor.armed.sl_tp_deadline'
  code_refs:
    - src/execution/execution/manager.ts:1179 (pollForEntryFill)
    - src/execution/execution/manager.ts:2649 (poll started after limit ACK)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_4_2a.okx.TIMING.LIMIT_PLACED_BEFORE_T_FUNDING
  category: TIMING
  severity: high
  description: >
    Limit order placed at T_f - 5s. The OKX limit order sits below current price
    in the order book until T_funding passes and the post-funding drop occurs.
    OKX timestamps in events are milliseconds.
  preconditions:
    - scheduler fires at entryAt
    - market above limit price at entryAt
  trigger_sequence:
    - evaluate() fires → limit entry placed
  expected_behavior:
    - order.placed (limit) logged at approximately entryAt
    - db:orders status=pending (not immediately filled)
  observability_contract:
    - log: 'order.placed (limit)' at ≈ entryAt
    - db:orders {status: "pending"} at entryAt + epsilon
  code_refs:
    - src/execution/execution/manager.ts:2578 (createOrder limit)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_4_2a.okx.TIMING.DEADLINE_FIRES_IF_FILLED
  category: TIMING
  severity: critical
  description: >
    If the limit order filled and monitoring is active, deadline timer fires at
    deadlineAt. SL and TP are cancelled, market close placed. This is the same
    sl_tp_deadline exit path as other strategies.
  preconditions:
    - intent in monitoring (limit order filled, SL and TP resting)
    - neither SL nor TP has filled before deadlineAt
  trigger_sequence:
    - monitor.settle('deadline') → handleMonitorExit
  expected_behavior:
    - monitor.deadline_fired logged
    - SL and TP cancelled
    - market close placed (sell, reduceOnly=true)
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'monitor.deadline_fired' {deadlineAt}
    - log: 'order.placed' {kind: "close", side: "sell", reduceOnly: true}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:115 (deadline timer for sl_tp_deadline)
    - src/execution/execution/manager.ts:1578 (cancel refs)
    - src/execution/execution/manager.ts:1660 (market close)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: routine

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_4_2a.okx.OCO.SL_FILLS_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    SL stop_market (sell) fills for the long position. OKX 'orders' emits state=filled
    for slId (dash-stripped). Monitor settle('sl'). handleMonitorExit cancels TP.
  preconditions:
    - intent in monitoring, price drops below SL stop price
  trigger_sequence:
    - OKX WS: 'orders' {state: "filled", clOrdId: <slId stripped>}
    - monitor.settle('sl')
  expected_behavior:
    - monitor.settle {reason: "sl"} logged
    - oco.cancel.start for TP ref
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: <tpId>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
  code_refs:
    - src/execution/execution/monitor.ts:124 (ws.order listener for SL fill)
    - src/execution/execution/manager.ts:1502 (cancel tp on sl exit)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_4_2a.okx.OCO.TP_FILLS_SL_CANCELED
  category: OCO
  severity: critical
  description: >
    TP limit (sell) fills for the long position. OKX 'orders' emits state=filled
    for tpId (dash-stripped). Monitor settle('tp'). handleMonitorExit cancels SL.
  preconditions:
    - intent in monitoring, price rises to TP limit price
  trigger_sequence:
    - OKX WS: 'orders' {state: "filled", clOrdId: <tpId stripped>}
    - monitor.settle('tp')
  expected_behavior:
    - monitor.settle {reason: "tp"} logged
    - oco.cancel.start for SL ref
    - intent.exited.complete {exitReason: "tp"}
  observability_contract:
    - log: 'monitor.settle' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: <slId>}
    - log: 'intent.exited.complete' {exitReason: "tp"}
  code_refs:
    - src/execution/execution/monitor.ts:131 (ws.order listener for TP fill)
    - src/execution/execution/manager.ts:1504 (cancel sl on tp exit)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: occasional

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_4_2a.okx.WEBSOCKET.RECONNECT_WHILE_LIMIT_RESTING
  category: WEBSOCKET
  severity: high
  description: >
    OKX WS disconnects and reconnects while the limit entry order is resting. store.reconcile
    called on reconnect — REST getOpenOrders confirms limit still live. byEntryOrderId map
    unchanged (in-memory). Expiry timer still fires at original deadlineAt.
  preconditions:
    - intent in working, limit order resting in OKX order book
    - WS disconnects and reconnects
  trigger_sequence:
    - ws.connection {state: "disconnected"} then {state: "connected"}
    - store.reconcile('okx')
  expected_behavior:
    - REST getOpenOrders includes the limit entry order
    - byEntryOrderId map unchanged, expiry timer unchanged
    - WS fill event after reconnect routes correctly via stripped ID
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal)
    - log: event='ws.connection' {exchange: "okx", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - limit entry order in REST getOpenOrders response
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: occasional

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_4_2a.okx.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_4_2a intent is in monitoring (limit filled,
    SL and TP resting). Recovery rehydrates IntentState. manager.start() re-arms
    sl_tp_deadline monitor. OKX canonicalize() applied to all IDs during recovery.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=sl_tp_deadline, exitOrderRefs.sl and .tp present
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor.armed.sl_tp_deadline logged (debug)
    - deadline timer and ws.order listeners re-armed
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.sl_tp_deadline' (debug)
  code_refs:
    - src/execution/recovery/index.ts:132 (canonicalize for OKX)
    - src/execution/recovery/index.ts:245 (rehydrated states log)
    - src/execution/execution/manager.ts:1888 (start — re-arm)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_4_2a.okx.RECOVERY.RESTART_WHILE_LIMIT_RESTING
  category: RECOVERY
  severity: high
  description: >
    Process restarts while the limit entry order is resting (status=working). Recovery
    sees the resting limit order as an orphan and cancels it. Intent stays in working
    or error state. No SL/TP are placed (position not opened).
  preconditions:
    - intent in DB with status=working, limit order resting in OKX book
  trigger_sequence:
    - process restart → runRecovery() → REST getOpenOrders: limit order found
    - 'recovery: orphan order found, cancelling' logged
    - cancelOrder(strippedClientOrderId) on OKX
  expected_behavior:
    - orphan limit cancelled on OKX
    - intent in error or abandoned state
    - no SL/TP placed
  observability_contract:
    - log: 'recovery: orphan order found, cancelling' {clientOrderId: "<stripped>"}
    - REST cancelOrder called for the limit entry
  code_refs:
    - src/execution/recovery/index.ts:271 (orphan cancel loop)
    - src/execution/recovery/index.ts:275 ('recovery: orphan order found, cancelling' log)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: rare

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_4_2a.okx.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active at submit time. Preflight rejects with code=kill_switch.
    No OKX limit order placed.
  preconditions:
    - kill switch mode != 'off'
    - strategy_4_2a condition met for okx
  trigger_sequence:
    - manager.submit() → preflight → killSwitch.canPlaceOrder() returns false
  expected_behavior:
    - intent.error logged with code=kill_switch
    - no order.placed
  observability_contract:
    - log: 'intent.error' {code: "kill_switch"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:intentLifecycleEvents decided→error
  code_refs:
    - src/execution/execution/preflight.ts:32 (kill switch check)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_4_2a.okx.SPEC_DIVERGENCE.OKX_DASH_STRIP
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    OKX requires dash-free clientOrderIds (max 32 chars alphanumeric). canonicalize()
    strips dashes for the limit entry clientOrderId, SL clientOrderId, and TP clientOrderId.
    Recovery also applies canonicalize(). Not in the strategy spec.
  preconditions:
    - strategy_4_2a intent submitted for okx
  trigger_sequence:
    - manager.submit() → canonicalize('okx', clientOrderId) → stripped ID used everywhere
  expected_behavior:
    - all OKX orders for this intent use dash-free IDs
    - WS fill events match correctly
  observability_contract:
    - db:orders clientOrderId: no dashes for okx rows
  code_refs:
    - src/execution/execution/manager.ts:130 (canonicalize)
    - src/execution/recovery/index.ts:132 (canonicalize in recovery)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: routine
```
