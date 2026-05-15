# Checklist — gateio / strategy_3a

Exchange: **gateio**
Strategy: **strategy_3a** (Negative Funding SHORT — Ride the Drop, Variant A)
Spec: `docs-strategy/strategies/strategy_3.md`
Code: `src/execution/strategies/strategy_3.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/gateio.ts`

---

**GateIO-specific notes:**
- REST entry (requiresWsOrderAdapter=false for strategy_3a)
- `futures.orders` WS channel for fills; timestamps in **seconds** (adapter × 1000)
- `cancelIgnoreCode: 'TEXT_DUPLICATED'` treated as success for OCO cancels
- Symbol normalization in `recovery.ts:302-305`
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_3a.gateio.ORDER_LIFECYCLE.ENTRY_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. A market SELL (SHORT) is placed via
    REST createOrder. No clientOrderId transformation for GateIO. order.placed logged
    with kind=entry, side=sell, orderType=market, reduceOnly=false.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent
    - available USDT >= amountUsd / leverage
    - kill switch inactive
  trigger_sequence:
    - scheduler fires at entryAt → manager.submit() → REST createOrder (SELL)
  expected_behavior:
    - intent.created logged (strategy=strategy_3a, exchange=gateio)
    - order.placed logged (kind=entry, side=sell, orderType=market, reduceOnly=false)
    - status decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_3a", exchange: "gateio"}
    - log: 'order.placed' {kind: "entry", side: "sell", orderType: "market", reduceOnly: false}
    - db:orders {kind: "entry", side: "sell", status: "pending"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:2079 (entrySide = 'sell' for short)
    - src/execution/execution/manager.ts:2697 (REST createOrder)
    - src/execution/execution/manager.ts:2756 (order.placed log)
    - src/execution/strategies/strategy_3.ts:52 (side: 'short')
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (Entry: market SELL at T_f - 5s)
  status: ⏳
  natural_occurrence: routine

- id: strategy_3a.gateio.ORDER_LIFECYCLE.ENTRY_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Entry market SELL fills. GateIO 'futures.orders' WS emits fill (SECOND timestamps,
    adapter × 1000). Manager routes via byEntryOrderId, logs order.filled, transitions
    to filled. handleEntryFilled places SL (buy stop_market) + TP (buy limit) simultaneously
    via REST and arms sl_tp_deadline monitor.
  preconditions:
    - entry order placed (status=working), GateIO WS connected
  trigger_sequence:
    - GateIO WS: futures.orders {status: "filled", text: <clientOrderId>, create_time: <seconds>}
    - adapter × 1000 for ms conversion
  expected_behavior:
    - order.filled logged (ms timestamps in DB)
    - position.opened logged (side=short)
    - SL (buy stop_market) + TP (buy limit) placed via REST
    - monitor.armed.sl_tp_deadline logged (debug)
  observability_contract:
    - log: 'order.filled' {exchange: "gateio", filledQty: ">0"}
    - log: 'position.opened' {side: "short"}
    - log: 'order.placed' {kind: "sl", side: "buy", orderType: "stop_market", reduceOnly: true}
    - log: 'order.placed' {kind: "tp", side: "buy", orderType: "limit", reduceOnly: true}
    - log: 'monitor.armed.sl_tp_deadline' (debug)
    - db:fills createdAt: in valid ms range
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/adapters/privatews/gateio.ts (futures.orders — ts * 1000)
    - src/execution/execution/manager.ts:406 (handleEntryFilled sl_tp_deadline)
    - src/execution/execution/manager.ts:409 (exitSide = 'buy' for short)
    - src/execution/execution/manager.ts:579 (SL placed)
    - src/execution/execution/manager.ts:580 (TP placed)
    - src/execution/execution/monitor.ts:149 (monitor.armed.sl_tp_deadline debug)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (Entry fill → SL + TP)
  status: ⏳
  natural_occurrence: routine

- id: strategy_3a.gateio.ORDER_LIFECYCLE.SL_OR_TP_PROTECTION_FAILURE
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    SL or TP REST createOrder rejected by GateIO. closeAfterProtectionFailure fires.
    Protective market close placed. Intent errors.
  preconditions:
    - entry filled, SL or TP createOrder rejected
  trigger_sequence:
    - sl or tp result.status === 'rejected'
    - closeAfterProtectionFailure called
  expected_behavior:
    - protective.close_placed logged (error)
    - intent.error logged
  observability_contract:
    - log: 'protective.close_placed' {code: "sl_tp_rejected"}
    - log: 'intent.error' {code: "sl_tp_rejected"}
    - db:intentLifecycleEvents filled→error
  code_refs:
    - src/execution/execution/manager.ts:273 (protective.close_placed)
    - src/execution/execution/manager.ts:536 (rejection check)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md
  status: ⏳
  natural_occurrence: rare

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_3a.gateio.TIMING.DEADLINE_FIRES
  category: TIMING
  severity: critical
  description: >
    Deadline timer fires at deadlineAt. handleMonitorExit cancels SL and TP
    (GateIO TEXT_DUPLICATED cancel treated as success), places market close
    (buy, reduceOnly=true) for the short position.
  preconditions:
    - intent in monitoring, deadline reached, neither SL nor TP filled
  trigger_sequence:
    - monitor.settle('deadline') → handleMonitorExit → cancel [sl, tp] → market close
  expected_behavior:
    - oco.cancel.start for SL and TP (TEXT_DUPLICATED → success)
    - order.placed {kind: "close", side: "buy", orderType: "market", reduceOnly: true}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'monitor.deadline_fired'
    - log: 'oco.cancel.start' x1 or x2
    - log: 'order.placed' {kind: "close", side: "buy", reduceOnly: true}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:115 (deadline timer for sl_tp_deadline)
    - src/execution/execution/manager.ts:1578 (cancel refs)
    - src/execution/execution/manager.ts:1660 (market close)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (Deadline exit)
  status: ⏳
  natural_occurrence: routine

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_3a.gateio.OCO.SL_FILLS_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    SL buy stop_market fills for the short. GateIO 'futures.orders' WS emits fill for
    SL (SECOND timestamps). Monitor settle('sl'). handleMonitorExit cancels TP via
    cancelSiblingExit. GateIO TEXT_DUPLICATED on cancel = success.
  preconditions:
    - intent in monitoring, SL and TP resting, price rises to SL stop level (short)
  trigger_sequence:
    - GateIO WS: futures.orders {status: "filled", text: <slClientOrderId>}
    - monitor.settle('sl') → handleMonitorExit
  expected_behavior:
    - monitor.settle {reason: "sl"} logged
    - oco.cancel.start for TP
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: <tpId>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
  code_refs:
    - src/execution/execution/monitor.ts:124 (ws.order listener SL fill)
    - src/execution/execution/manager.ts:1502 (cancel tp on sl exit)
    - src/execution/execution/manager.ts:1407 (cancelSiblingExit — TEXT_DUPLICATED handled)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (SL exit)
  status: ⏳
  natural_occurrence: occasional

- id: strategy_3a.gateio.OCO.TP_FILLS_SL_CANCELED
  category: OCO
  severity: critical
  description: >
    TP buy limit fills for the short (price drops to TP level = profit). GateIO
    'futures.orders' emits fill for TP. Monitor settle('tp'). handleMonitorExit cancels SL.
  preconditions:
    - TP resting, price drops to TP limit level (short position)
  trigger_sequence:
    - GateIO WS: futures.orders {status: "filled", text: <tpClientOrderId>}
    - monitor.settle('tp') → handleMonitorExit
  expected_behavior:
    - monitor.settle {reason: "tp"} logged
    - oco.cancel.start for SL
    - intent.exited.complete {exitReason: "tp"}
  observability_contract:
    - log: 'monitor.settle' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: <slId>}
    - log: 'intent.exited.complete' {exitReason: "tp"}
  code_refs:
    - src/execution/execution/monitor.ts:131 (ws.order listener TP fill)
    - src/execution/execution/manager.ts:1504 (cancel sl on tp exit)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (TP exit)
  status: ⏳
  natural_occurrence: occasional

- id: strategy_3a.gateio.OCO.TEXT_DUPLICATED_CANCEL_TREATED_AS_SUCCESS
  category: OCO
  severity: medium
  description: >
    During cancelSiblingExit (OCO cancel), GateIO returns TEXT_DUPLICATED error code
    for a cancel request (order already cancelled or filled). cancelIgnoreCode='TEXT_DUPLICATED'
    causes this to be treated as a successful cancel. No error is logged. The OCO proceeds.
  preconditions:
    - cancelSiblingExit called on GateIO for SL or TP
    - GateIO returns TEXT_DUPLICATED (order already gone)
  trigger_sequence:
    - cancelOrder → GateIO: TEXT_DUPLICATED
    - cancelIgnoreCode check: TEXT_DUPLICATED → return success
  expected_behavior:
    - oco.cancel.success logged (not error)
    - OCO proceeds normally to exit
  observability_contract:
    - log: 'oco.cancel.success' (not 'oco.cancel.failed')
    - OCO completes normally
  code_refs:
    - src/execution/execution/manager.ts:1407 (cancelSiblingExit — cancelIgnoreCode logic)
    - src/execution/adapters/gateio.ts (cancelIgnoreCode: 'TEXT_DUPLICATED')
  spec_refs:
    - docs-strategy/strategies/strategy_3.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    TEXT_DUPLICATED occurs when a cancel race condition: SL/TP already filled or cancelled
    by another path before our cancelSiblingExit arrives. Without this ignore, OCO would fail.

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_3a.gateio.WEBSOCKET.RECONNECT_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    GateIO WS reconnects during monitoring. store.reconcile fetches SL/TP from REST.
    Deadline timer unchanged.
  preconditions:
    - intent in monitoring, SL and TP resting
    - WS disconnects and reconnects
  trigger_sequence:
    - ws.connection → {state: "connected"} → store.reconcile('gateio')
  expected_behavior:
    - SL/TP orders visible in REST getOpenOrders
    - deadline timer unchanged
    - no duplicate exit
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal)
    - log: event='ws.connection' {exchange: "gateio", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - SL/TP in REST getOpenOrders
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md
  status: ⏳
  natural_occurrence: occasional

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_3a.gateio.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_3a intent is in monitoring. Recovery rehydrates
    IntentState + exitOrderRefs (sl, tp). manager.start() re-arms sl_tp_deadline monitor.
    GateIO symbol normalization at recovery.ts:302-305. Deadline timer re-armed.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=sl_tp_deadline
    - exitOrderRefs.sl and .tp present
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
    - src/execution/recovery/index.ts:302 (GateIO symbol normalization)
    - src/execution/recovery/index.ts:245 (rehydrated states log)
    - src/execution/execution/manager.ts:1888 (start — re-arm)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_3a.gateio.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects with code=kill_switch. No GateIO REST call.
  preconditions:
    - kill switch mode != 'off', strategy_3a condition met for gateio
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
    - docs-strategy/strategies/strategy_3.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_3a.gateio.SPEC_DIVERGENCE.GATEIO_TIMESTAMP_SECONDS
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    GateIO WS events use SECOND timestamps. Adapter × 1000 required for all extracted
    timestamps. Critical for SL/TP fill event routing (timestamp in DB) and for any
    timing-based logic.
  preconditions:
    - GateIO WS events processed in futures.orders channel
  trigger_sequence:
    - GateIO WS: futures.orders {create_time: <seconds>}
    - adapter: ts_ms = create_time * 1000
  expected_behavior:
    - db:fills createdAt in valid ms range (>1700000000000)
  observability_contract:
    - db:fills createdAt > 1700000000000 for all gateio rows
  code_refs:
    - src/execution/adapters/privatews/gateio.ts (timestamp conversion)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md
  status: ⏳
  natural_occurrence: routine
```
