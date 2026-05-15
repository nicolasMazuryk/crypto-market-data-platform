# Checklist — okx / strategy_3a

Exchange: **okx**
Strategy: **strategy_3a** (Negative Funding SHORT — Ride the Drop, Variant A)
Spec: `docs-strategy/strategies/strategy_3.md`
Code: `src/execution/strategies/strategy_3.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_3a.okx.ORDER_LIFECYCLE.ENTRY_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. setLeverage succeeds. A market
    SELL order (SHORT) is placed via REST createOrder (requiresWsOrderAdapter=false
    for strategy_3a). canonicalize() strips dashes from the clientOrderId for OKX
    before registration in byEntryOrderId. order.placed logged with kind=entry,
    side=sell, orderType=market, reduceOnly=false.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent (negative funding required)
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - market status = trading
  trigger_sequence:
    - scheduler: evaluator fires at entryAt = nextFundingTimestamp - entryOffsetSeconds * 1000
    - manager.submit() called with strategy_3a TradeIntent (side=short, exchange=okx)
  expected_behavior:
    - intent.created logged (strategy=strategy_3a, exchange=okx)
    - intent.submitted logged (entryKind=market)
    - clientOrderId dash-stripped by canonicalize() before byEntryOrderId registration
    - order.placed logged (kind=entry, side=sell, orderType=market, reduceOnly=false)
    - status transitions decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_3a", exchange: "okx"}
    - log: 'intent.submitted' {entryKind: "market"}
    - log: 'order.placed' {kind: "entry", side: "sell", orderType: "market", reduceOnly: false}
    - db:orders row {kind: "entry", orderType: "market", side: "sell", reduceOnly: false, status: "pending"}
    - db:intentLifecycleEvents transitions decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:130 (canonicalize — strips dashes for OKX)
    - src/execution/execution/manager.ts:2079 (entrySide = 'sell' for short)
    - src/execution/execution/manager.ts:2081 (transition submitted)
    - src/execution/execution/manager.ts:2697 (REST createOrder for market entry)
    - src/execution/execution/manager.ts:2756 (order.placed log)
    - src/execution/strategies/strategy_3.ts:52 (side: 'short')
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (Entry: market SELL at T_f - 5s)
  status: ⏳
  natural_occurrence: routine
  notes: >
    strategy_3a uses REST (not WS) for entry. OKX REST createOrder returns
    exchangeOrderId in the ACK. Dash-stripped clientOrderId is pre-registered
    in byEntryOrderId before the REST call to handle racing WS fill events.

- id: strategy_3a.okx.ORDER_LIFECYCLE.ENTRY_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Entry market SELL order fills. OKX private WS emits on 'orders' channel with
    state=filled and clOrdId = dash-stripped clientOrderId. Manager routes via
    byEntryOrderId lookup, logs order.filled, transitions to filled, then
    handleEntryFilled places SL (buy stop_market) + TP (buy limit) simultaneously
    and arms the sl_tp_deadline monitor.
  preconditions:
    - entry order placed (status=working or acked)
    - OKX private WS connected
  trigger_sequence:
    - OKX WS: 'orders' channel {state: "filled", clOrdId: <stripped-clientOrderId>, side: "sell"}
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice present)
    - status transitions working → filled → monitoring
    - position.opened logged (side=short, filledQty > 0)
    - SL (buy stop_market) + TP (buy limit) placed simultaneously via REST
    - monitor.armed.sl_tp_deadline logged (debug) with deadlineDelay, slId, tpId
  observability_contract:
    - log: 'order.filled' {exchange: "okx", filledQty: ">0"}
    - log: 'position.opened' {side: "short", filledQty: ">0"}
    - log: 'order.placed' {kind: "sl", side: "buy", orderType: "stop_market", reduceOnly: true}
    - log: 'order.placed' {kind: "tp", side: "buy", orderType: "limit", reduceOnly: true}
    - log: 'monitor.armed.sl_tp_deadline' {deadlineDelay, slId, tpId}  # debug
    - db:orders rows {kind: "sl"} and {kind: "tp"} both pending
    - db:intentLifecycleEvents transition filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:130 (canonicalize — lookup key is stripped form)
    - src/execution/execution/manager.ts:1136 (handleEntryOrderEvent fill branch)
    - src/execution/execution/manager.ts:1156 (order.filled log)
    - src/execution/execution/manager.ts:406 (handleEntryFilled sl_tp_deadline branch)
    - src/execution/execution/manager.ts:409 (exitSide = 'buy' for short)
    - src/execution/execution/manager.ts:579 (order.placed sl log)
    - src/execution/execution/manager.ts:580 (order.placed tp log)
    - src/execution/execution/monitor.ts:149 (monitor.armed.sl_tp_deadline debug log)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (Entry fill → place SL + TP)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX avgPx field carries avgFillPrice. OKX timestamps in 'orders' channel are ms.
    SL/TP clientOrderIds also dash-stripped by canonicalize() before placement.

- id: strategy_3a.okx.ORDER_LIFECYCLE.ENTRY_REST_POLL_FALLBACK
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    OKX WS 'orders' fill event for the entry order does not arrive in time.
    pollForEntryFill (15 × 1s) detects the fill via REST getOrder and drives the
    intent to filled → monitoring (SL + TP placed, monitor armed).
  preconditions:
    - entry order placed (status=working)
    - OKX WS fill event missed or delayed
  trigger_sequence:
    - pollForEntryFill loop: getOrder returns status=filled
    - handleEntryFilled called from poll path
  expected_behavior:
    - order.filled logged (from poll path)
    - SL + TP placed via REST
    - monitor armed (sl_tp_deadline)
  observability_contract:
    - log: 'order.filled' (no prior WS fill event for this intentId)
    - log: 'order.placed' {kind: "sl"} and {kind: "tp"}
    - log: 'monitor.armed.sl_tp_deadline'
  code_refs:
    - src/execution/execution/manager.ts:1179 (pollForEntryFill)
    - src/execution/execution/manager.ts:2787 (poll started after REST createOrder ACK)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_3a.okx.ORDER_LIFECYCLE.SL_OR_TP_PROTECTION_FAILURE
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    After entry fill, REST createOrder for SL or TP returns rejected (OKX error).
    closeAfterProtectionFailure fires with code=sl_tp_rejected. A protective market
    close is placed immediately. Intent transitions to error.
  preconditions:
    - entry filled, SL or TP REST createOrder returns rejected
  trigger_sequence:
    - handleEntryFilled: sl or tp createOrder result.status === 'rejected'
    - closeAfterProtectionFailure called
  expected_behavior:
    - protective.close_placed logged (error level)
    - order.placed {kind: "close", reduceOnly: true, side: "buy"}
    - intent.error logged
    - db:intentLifecycleEvents filled→error
  observability_contract:
    - log: 'protective.close_placed' {code: "sl_tp_rejected"}  # error level
    - log: 'intent.error' {code: "sl_tp_rejected"}
    - db:intentLifecycleEvents filled→error
  code_refs:
    - src/execution/execution/manager.ts:273 (protective.close_placed log)
    - src/execution/execution/manager.ts:536 (SL/TP rejection check)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (no protection failure in spec)
  status: ⏳
  natural_occurrence: rare

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_3a.okx.TIMING.ENTRY_AT_CORRECT_OFFSET
  category: TIMING
  severity: high
  description: >
    Entry REST createOrder placed at approximately T_f - 5s. Elapsed time from
    entryAt to order.placed should be within a few hundred ms (REST round-trip +
    setLeverage). OKX REST latency typically 100-300ms.
  preconditions:
    - scheduler running, strategy condition met
  trigger_sequence:
    - scheduler fires evaluate() at entryAt = nextFundingTimestamp - entryOffsetSeconds*1000
  expected_behavior:
    - intent.submitted timestamp <= entryAt + 1000ms
    - order.placed (kind=entry) timestamp <= entryAt + 1500ms
  observability_contract:
    - log: 'intent.submitted' timestamp <= entryAt + 1000ms
    - log: 'order.placed' {kind: "entry"} timestamp <= entryAt + 1500ms
    - db:orders {kind: "entry"} createdAt within [entryAt, entryAt + 1500ms]
  code_refs:
    - src/execution/strategies/strategy_3.ts:42 (entryAt = nextFundingTimestamp - entryOffsetSeconds*1000)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (Entry at T_f - 5s)
  status: ⏳
  natural_occurrence: routine

- id: strategy_3a.okx.TIMING.DEADLINE_FIRES
  category: TIMING
  severity: critical
  description: >
    Deadline timer fires at deadlineAt. Monitor settle('deadline') called.
    handleMonitorExit cancels both SL and TP via cancelSiblingExit then places
    a market close (buy, reduceOnly=true) for the short position.
  preconditions:
    - intent in monitoring, neither SL nor TP filled before deadline
  trigger_sequence:
    - setTimeout fires at deadlineAt - skewMs
    - monitor.settle('deadline') → handleMonitorExit(s, 'deadline')
  expected_behavior:
    - monitor.deadline_fired logged {deadlineAt}
    - oco.cancel.start logged for SL and TP
    - order.placed {kind: "close", side: "buy", orderType: "market", reduceOnly: true}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'monitor.deadline_fired' {intentId, deadlineAt}
    - log: 'monitor.settle' {reason: "deadline"}
    - log: 'intent.exiting.start' {reason: "deadline"}
    - log: 'order.placed' {kind: "close", side: "buy", reduceOnly: true}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:115 (deadline timer setup for sl_tp_deadline)
    - src/execution/execution/monitor.ts:116 (monitor.deadline_fired log)
    - src/execution/execution/monitor.ts:93 (monitor.settle log)
    - src/execution/execution/manager.ts:1578 (cancel refs loop)
    - src/execution/execution/manager.ts:1660 (order.placed close)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (Deadline exit)
  status: ⏳
  natural_occurrence: routine

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_3a.okx.OCO.SL_FILLS_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    SL stop_market (buy) fills. OKX emits on 'orders' channel with state=filled
    for the SL order. Monitor's ws.order listener detects fill (slId matches),
    calls settle('sl'). handleMonitorExit cancels the TP via cancelSiblingExit.
  preconditions:
    - intent in monitoring, SL and TP resting
    - price rises to SL trigger level (short position)
  trigger_sequence:
    - OKX WS: 'orders' {state: "filled", clOrdId: <slId stripped>}
    - monitor.settle('sl') → handleMonitorExit(s, 'sl')
  expected_behavior:
    - monitor.settle {reason: "sl"} logged
    - intent.exiting.start {reason: "sl"} logged
    - oco.cancel.start logged for TP ref
    - oco.cancel.success logged
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'intent.exiting.start' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: <tpId stripped>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:124 (ws.order listener for SL fill — sl_tp_deadline arm)
    - src/execution/execution/monitor.ts:141 (settle 'sl')
    - src/execution/execution/manager.ts:1502 (reason=sl: cancel tp ref)
    - src/execution/execution/manager.ts:1520 (cancelSiblingExit call)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (SL fills → cancel TP → exit)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    OKX SL (buy stop_market) triggers when ask price rises to stop price for short.
    OKX conditional algo orders trigger on the 'orders' channel when filled.
    cancelSiblingExit strategies A (clientOrderId), B (exchangeOrderId), C (REST verify).

- id: strategy_3a.okx.OCO.TP_FILLS_SL_CANCELED
  category: OCO
  severity: critical
  description: >
    TP limit (buy) order fills. OKX emits on 'orders' channel with state=filled
    for the TP. Monitor's ws.order listener detects fill (tpId matches),
    calls settle('tp'). handleMonitorExit cancels the SL via cancelSiblingExit.
  preconditions:
    - intent in monitoring, SL and TP resting
    - price drops to TP limit price (short position — price falls to profit target)
  trigger_sequence:
    - OKX WS: 'orders' {state: "filled", clOrdId: <tpId stripped>}
    - monitor.settle('tp') → handleMonitorExit(s, 'tp')
  expected_behavior:
    - monitor.settle {reason: "tp"} logged
    - intent.exiting.start {reason: "tp"} logged
    - oco.cancel.start logged for SL ref
    - oco.cancel.success logged
    - intent.exited.complete {exitReason: "tp"}
  observability_contract:
    - log: 'monitor.settle' {reason: "tp"}
    - log: 'intent.exiting.start' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: <slId stripped>}
    - log: 'intent.exited.complete' {exitReason: "tp"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:131 (ws.order listener for TP fill — sl_tp_deadline arm)
    - src/execution/execution/monitor.ts:141 (settle 'tp')
    - src/execution/execution/manager.ts:1504 (reason=tp: cancel sl ref)
    - src/execution/execution/manager.ts:1520 (cancelSiblingExit call)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (TP fills → cancel SL → exit)
  status: ⏳
  natural_occurrence: occasional

- id: strategy_3a.okx.OCO.SWEEP_AFTER_EXIT
  category: OCO
  severity: medium
  description: >
    After exit (any reason: sl, tp, deadline), sweepReduceOnlyOrders is called to
    cancel any residual reduce-only orders on OKX that were not caught by
    cancelSiblingExit (e.g., stale orders from a crashed previous session).
  preconditions:
    - intent transitioning to exited
    - residual reduce-only orders exist on OKX
  trigger_sequence:
    - handleMonitorExit completes → sweepReduceOnlyOrders called
  expected_behavior:
    - oco.sweep.start logged
    - REST getOpenOrders fetched for OKX
    - cancelOrder called for each reduce-only order found
    - oco.sweep.complete logged with foundCount
  observability_contract:
    - log: 'oco.sweep.start' {exchange: "okx"}
    - log: 'oco.sweep.complete' {exchange: "okx", foundCount: ">=0"}
  code_refs:
    - src/execution/execution/manager.ts:1350 (sweepReduceOnlyOrders)
    - src/execution/execution/manager.ts:1561 (sweepReduceOnlyOrders call in OCO path)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md
  status: ⏳
  natural_occurrence: occasional

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_3a.okx.WEBSOCKET.RECONNECT_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    OKX private WS disconnects and reconnects while intent is in monitoring (SL
    and TP resting). store.reconcile called on reconnect fetches open orders from
    REST. Deadline timer remains armed. No duplicate exit triggered.
  preconditions:
    - intent in monitoring, SL and TP resting
    - OKX WS disconnects and reconnects
  trigger_sequence:
    - ws.connection {state: "disconnected"} then {state: "connected"}
    - store.reconcile('okx') called
  expected_behavior:
    - REST getOpenOrders returns SL and TP for okx
    - state maps updated
    - deadline timer unchanged
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal — no logger.info)
    - log: event='ws.connection' {exchange: "okx", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - SL and TP orders present in REST getOpenOrders after reconnect
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile call)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_3a.okx.WEBSOCKET.CLOSE_FILL_WS_VS_POLL
  category: WEBSOCKET
  severity: medium
  description: >
    After the close market order is placed (deadline, SL, or TP path), the fill
    is detected either via OKX WS 'orders' channel (primary) or pollForCloseFill
    (20 × 1s REST fallback). Both the WS path and the REST poll path log intent.exited.complete.
  preconditions:
    - close order placed (status=exiting)
  trigger_sequence:
    - OKX WS 'orders' fill OR pollForCloseFill getOrder returns filled
  expected_behavior:
    - via WS: order.filled logged, intent transitions to exited (no intent.exited.complete)
    - via REST poll: order.filled logged, intent.exited.complete logged
  observability_contract:
    - log: 'order.filled' {kind: "close"} (both paths)
    - log: 'intent.exited.complete' ONLY if REST poll detected fill (not WS path)
    - db:intentLifecycleEvents exiting→exited (both paths)
  code_refs:
    - src/execution/execution/manager.ts:1914 (WS close fill handler — no intent.exited.complete)
    - src/execution/execution/manager.ts:1255 (pollForCloseFill — emits intent.exited.complete)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    intent.exited.complete is logged on both the WS fill path and the REST poll path.

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_3a.okx.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_3a intent is in monitoring (SL and TP resting).
    Recovery rehydrates IntentState including exitOrderRefs (sl, tp). manager.start()
    re-arms sl_tp_deadline monitor. canonicalize() applied to all OKX clientOrderIds
    during recovery. WS listeners re-wired to stripped slId/tpId.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=sl_tp_deadline
    - exitOrderRefs.sl and optionally .tp present in DB
  trigger_sequence:
    - process restart → runRecovery() → manager.start() re-arms monitoring intents
  expected_behavior:
    - 'recovery: rehydrated intent states' logged (rehydratedCount >= 1)
    - monitor.armed.sl_tp_deadline logged (debug)
    - deadline timer re-armed; SL and TP ws.order listeners re-wired
    - if deadlineAt past: fires immediately
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.sl_tp_deadline' {deadlineDelay, slId, tpId}  # debug
  code_refs:
    - src/execution/recovery/index.ts:132 (canonicalize applied during recovery)
    - src/execution/recovery/index.ts:245 (rehydrated intent states log)
    - src/execution/execution/manager.ts:1888 (start — re-arm monitoring intents)
    - src/execution/execution/monitor.ts:108 (sl_tp_deadline arm branch)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    OKX canonicalize() strips dashes from both slId and tpId in recovery. If
    OKX WS fill events arrive during recovery (race), the re-registered byCloseOrderId
    map handles them correctly with stripped IDs.

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_3a.okx.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active at submit time. Preflight rejects with code=kill_switch.
    No OKX REST call made.
  preconditions:
    - kill switch mode != 'off'
    - strategy_3a condition met for okx
  trigger_sequence:
    - manager.submit() → preflight → killSwitch.canPlaceOrder() returns false
  expected_behavior:
    - intent.created logged
    - intent.error logged with code=kill_switch
    - no order.placed
  observability_contract:
    - log: 'intent.error' {code: "kill_switch"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:intentLifecycleEvents decided→error
  code_refs:
    - src/execution/execution/preflight.ts:32 (kill switch check)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_3a.okx.SPEC_DIVERGENCE.OKX_CLIENT_ORDER_ID_DASH_STRIP
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    OKX rejects clientOrderIds with dashes. canonicalize() strips dashes for all
    order IDs (entry, SL, TP, close). Recovery also applies canonicalize(). This is
    not in the strategy spec but is OKX-specific implementation behavior critical
    for correct WS fill event routing.
  preconditions:
    - any intent submitted for okx with UUID-format clientOrderIds
  trigger_sequence:
    - manager.submit() → canonicalize('okx', clientOrderId) strips dashes
    - All subsequent IDs (SL, TP) also stripped before registration in byCloseOrderId
  expected_behavior:
    - all OKX orders use dash-free clientOrderIds (max 32 chars alphanumeric)
    - WS fill events match by stripped clOrdId
    - no 'order not found' errors in WS routing
  observability_contract:
    - db:orders clientOrderId column: no dashes for okx rows
    - no unmatched fill events (verify in logs)
  code_refs:
    - src/execution/execution/manager.ts:130 (canonicalize)
    - src/execution/recovery/index.ts:132 (canonicalize in recovery)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (no mention of clientOrderId format)
  status: ⏳
  natural_occurrence: routine
  notes: >
    This applies to ALL strategies on OKX, not just strategy_3a. Documented here
    as a spec divergence because the strategy spec does not mention OKX ID constraints.
```
