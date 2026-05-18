# Checklist — gateio / strategy_2

Exchange: **gateio**
Strategy: **strategy_2** (Negative Funding LONG — Retracement Exit)
Spec: `docs-strategy/strategies/strategy_2.md`
Code: `src/execution/strategies/strategy_2.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/gateio.ts`

---

**GateIO-specific notes:**
- WS entry via WS order adapter (requiresWsOrderAdapter=true)
- `futures.orders` channel for fill events; timestamps in **seconds** (adapter × 1000)
- Funding fee: GateIO account WS channel with fund bizType → ws.funding_fee bus event
- `cancelIgnoreCode: 'TEXT_DUPLICATED'` treated as success
- Symbol normalization in `recovery.ts:302-305`
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_2.gateio.ORDER_LIFECYCLE.ENTRY_FILLED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Entry fills. GateIO 'futures.orders' WS channel emits fill with SECOND timestamps
    (adapter × 1000). Manager routes via byEntryOrderId, logs order.filled, transitions
    to filled. handleEntryFilled places SL (stop_market, sell, reduceOnly=true) immediately
    and arms the retracement monitor. spawnRetracementTracker called.
  preconditions:
    - entry order placed (status=working)
    - GateIO WS connected
  trigger_sequence:
    - GateIO WS: futures.orders {status: "filled", text: <clientOrderId>, create_time: <seconds>}
    - adapter × 1000 for ms conversion
  expected_behavior:
    - order.filled logged (ms timestamps in DB)
    - SL placed immediately (stop_market, sell, reduceOnly=true)
    - position.opened logged (side=long)
    - monitor.armed.sl_tp_deadline_retracement logged (debug)
  observability_contract:
    - log: 'order.filled' {exchange: "gateio", filledQty: ">0"}
    - log: 'order.placed' {kind: "sl", side: "sell", orderType: "stop_market"}
    - log: 'position.opened' {side: "long"}
    - log: 'monitor.armed.sl_tp_deadline_retracement' {deadlineDelay, slId}
    - db:fills createdAt: in valid ms range
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/adapters/privatews/gateio.ts (futures.orders — ts * 1000)
    - src/execution/execution/manager.ts:292 (handleEntryFilled retracement)
    - src/execution/execution/manager.ts:368 (SL placed)
    - src/execution/execution/manager.ts:402 (spawnRetracementTracker)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (SL placed immediately after fill)
  status: ⏳
  natural_occurrence: routine
  notes: >
    GateIO timestamps in seconds. If adapter misses × 1000, SL stopPrice computation
    is unaffected (it uses avgFillPrice not timestamps), but DB records are wrong.

- id: strategy_2.gateio.ORDER_LIFECYCLE.SL_REJECTED_PROTECTIVE_CLOSE
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    SL placement returns rejected (GateIO error). closeAfterProtectionFailure fires
    with code=retracement_sl_rejected. Protective market close placed immediately.
    Intent transitions to error.
  preconditions:
    - entry filled, SL REST createOrder returns rejected
  trigger_sequence:
    - handleEntryFilled: slResult.status === 'rejected'
    - closeAfterProtectionFailure(s, 'retracement_sl_rejected')
  expected_behavior:
    - protective.close_placed logged (error level)
    - intent.error {code: "retracement_sl_rejected"}
  observability_contract:
    - log: 'protective.close_placed' {code: "retracement_sl_rejected"}
    - log: 'intent.error' {code: "retracement_sl_rejected"}
    - db:intentLifecycleEvents filled→error
  code_refs:
    - src/execution/execution/manager.ts:345 (slResult rejected)
    - src/execution/execution/manager.ts:273 (protective.close_placed)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: rare

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_2.gateio.TIMING.FUNDING_FEE_EVENT_OPENS_GATE
  category: TIMING
  severity: critical
  description: >
    At T_f, GateIO emits a funding fee event on the private WS (account.book channel
    or equivalent). GateIO WS adapter maps to ws.funding_fee bus event (with timestamp
    converted from seconds to ms). Retracement tracker's bus.on('ws.funding_fee') handler
    matches by exchange/symbol/fundingTime (±5s), sets fundingGateOpen=true, P_low tracking begins.
  preconditions:
    - intent in monitoring, tracker running
    - GateIO emits funding event at T_f for the correct symbol
  trigger_sequence:
    - GateIO WS: account.book {bizType: <fund-related>, contract: <symbol>}
    - adapter → bus.emit('ws.funding_fee', {exchange: "gateio", symbol, fundingTime: ts*1000})
    - tracker: fundingGateOpen = true
  expected_behavior:
    - fundingGateOpen = true
    - P_low tracking begins on next 1s tick
    - db:fundingAttributions row inserted
  observability_contract:
    - bus: 'ws.funding_fee' {exchange: "gateio", symbol: <normalized>}
    - log: event='intent.funding_gate_opened' {intentId: "<id>", openedAt: ">0", fundingTs: ">0"}
    - log: 'retracement.tp_placed' may appear shortly after (if P_low makes new low)
    - db:fundingAttributions row
  code_refs:
    - src/execution/adapters/privatews/gateio.ts (account.book → ws.funding_fee, ts*1000)
    - src/execution/execution/manager.ts:871 (bus.on ws.funding_fee in tracker)
    - src/execution/execution/manager.ts:875 (fundingGateOpen = true)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (P_low tracking after funding fee)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Verify GateIO's exact WS channel name and bizType string for funding fee events.
    GateIO timestamp must be × 1000 before the bus event for the ±5000ms tolerance
    in monitor.ts:201 to work correctly.

- id: strategy_2.gateio.TIMING.DEADLINE_FIRES
  category: TIMING
  severity: critical
  description: >
    Deadline timer fires at deadlineAt. Monitor settle('deadline'). handleMonitorExit
    cancels SL and TP (if placed) via cancelSiblingExit, then places market close.
    GateIO cancelOrder may return TEXT_DUPLICATED (treated as success).
  preconditions:
    - intent in monitoring, deadline reached
  trigger_sequence:
    - monitor.settle('deadline') → handleMonitorExit
  expected_behavior:
    - oco.cancel.start for SL and TP (TEXT_DUPLICATED on cancel = success)
    - order.placed {kind: "close", orderType: "market", reduceOnly: true}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'monitor.deadline_fired'
    - log: 'oco.cancel.start' (x1 or x2 depending on TP presence)
    - log: 'order.placed' {kind: "close"}
    - log: event='intent.funding_gate_closed' {intentId: "<id>", reason: "deadline", durationMs: ">0"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:156 (deadline timer)
    - src/execution/execution/manager.ts:1578 (cancel refs loop)
    - src/execution/execution/manager.ts:1660 (market close)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (Deadline exit)
  status: ⏳
  natural_occurrence: routine

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_2.gateio.OCO.SL_FILLS_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    SL stop_market fills. GateIO 'futures.orders' WS emits fill for SL order (SECOND
    timestamps). Monitor settles('sl'). handleMonitorExit cancels TP via cancelSiblingExit.
    GateIO TEXT_DUPLICATED on cancel treated as success.
  preconditions:
    - intent in monitoring, SL and TP resting, price drops to SL trigger
  trigger_sequence:
    - GateIO WS: futures.orders {status: "filled", text: <slClientOrderId>}
    - monitor.settle('sl') → handleMonitorExit
  expected_behavior:
    - monitor.settle {reason: "sl"} logged
    - oco.cancel.start for TP (TEXT_DUPLICATED treated as success)
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: <tpId>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
    - log: event='intent.funding_gate_closed' {intentId: "<id>", reason: "sl", durationMs: ">0"}
  code_refs:
    - src/execution/execution/monitor.ts:166 (ws.order listener for SL)
    - src/execution/execution/manager.ts:1502 (cancel tp on sl exit)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (SL exit)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    GateIO WS fill for SL carries SECOND timestamps — adapter converts to ms.
    TEXT_DUPLICATED cancel code: cancelSiblingExit strategy A/B/C handles this via
    GateIO cancelIgnoreCode='TEXT_DUPLICATED' configuration.

- id: strategy_2.gateio.OCO.TP_FILLS_SL_CANCELED
  category: OCO
  severity: critical
  description: >
    TP limit fills. GateIO 'futures.orders' emits fill for TP. Tracker's currentTpUnsub
    fires → settleTp → monitor.disarm → handleMonitorExit('tp') → cancel SL.
  preconditions:
    - TP limit resting, SL resting, price retraces to TP level
  trigger_sequence:
    - GateIO WS: futures.orders {status: "filled", text: <tpClientOrderId>}
    - tracker settleTp → monitor.disarm → handleMonitorExit('tp')
  expected_behavior:
    - intent.exiting.start {reason: "tp"} logged
    - oco.cancel.start for SL
    - intent.exited.complete {exitReason: "tp"}
  observability_contract:
    - log: 'intent.exiting.start' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: <slId>}
    - log: 'intent.exited.complete' {exitReason: "tp"}
    - log: event='intent.funding_gate_closed' {intentId: "<id>", reason: "tp", durationMs: ">0"}
  code_refs:
    - src/execution/execution/manager.ts:935 (tracker currentTpUnsub)
    - src/execution/execution/manager.ts:843 (monitor.disarm)
    - src/execution/execution/manager.ts:844 (handleMonitorExit 'tp')
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (TP exit)
  status: ⏳
  natural_occurrence: occasional

# ── STRATEGY_SPECIFIC ────────────────────────────────────────────────────────

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_2.gateio.WEBSOCKET.RECONNECT_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    GateIO WS reconnects during monitoring. store.reconcile fetches SL/TP from REST.
    Deadline timer unchanged. Retracement tracker continues via bus.on (survives reconnect).
  preconditions:
    - intent in monitoring, SL resting, WS disconnects and reconnects
  trigger_sequence:
    - ws.connection → {state: "connected"} → store.reconcile
  expected_behavior:
    - SL/TP fetched from REST (still resting)
    - deadline timer unchanged
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal)
    - log: event='ws.connection' {exchange: "gateio", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - SL/TP in REST getOpenOrders after reconnect
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: occasional

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_2.gateio.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_2 intent is in monitoring on GateIO. Recovery
    rehydrates IntentState + exitOrderRefs (sl, tp). manager.start() re-arms
    sl_tp_deadline_retracement monitor. GateIO symbol normalization at recovery.ts:302-305.
    spawnRetracementTracker NOT re-called after recovery.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=sl_tp_deadline_retracement_funding_event
    - exitOrderRefs.sl present
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor.armed.sl_tp_deadline_retracement logged (debug)
    - deadline timer and SL ws.order listener re-wired
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.sl_tp_deadline_retracement' (debug)
  code_refs:
    - src/execution/recovery/index.ts:302 (GateIO symbol normalization)
    - src/execution/recovery/index.ts:245 (rehydrated states log)
    - src/execution/execution/manager.ts:1892 (re-arm monitoring intents)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_2.gateio.SPEC_DIVERGENCE.GATEIO_TIMESTAMP_SECONDS
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    GateIO WS events use SECOND timestamps. All GateIO WS handler code must × 1000.
    If missing, fill timestamps in DB are wrong and ws.funding_fee fundingTime matching
    (±5000ms tolerance in monitor.ts) will fail if comparison is ms vs seconds.
  preconditions:
    - GateIO WS adapter processing futures.orders or account.book events
  trigger_sequence:
    - GateIO WS event with second-precision timestamps
    - adapter × 1000 for all extracted timestamps
  expected_behavior:
    - all DB timestamps in valid ms range
    - ws.funding_fee fundingTime in ms → monitor tolerance check works
  observability_contract:
    - db:fills createdAt > 1700000000000
    - 'monitor.settle' latencyMs < 10000 (not millions)
  code_refs:
    - src/execution/adapters/privatews/gateio.ts (timestamp conversion)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_2.gateio.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects with code=kill_switch. No GateIO WS call.
  preconditions:
    - kill switch mode != 'off', strategy_2 condition met for gateio
  trigger_sequence:
    - manager.submit() → preflight → kill_switch
  expected_behavior:
    - intent.error {code: "kill_switch"}
    - no order.placed
  observability_contract:
    - log: 'intent.error' {code: "kill_switch"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:intentLifecycleEvents decided→error
  code_refs:
    - src/execution/execution/preflight.ts:32
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: occasional
```
