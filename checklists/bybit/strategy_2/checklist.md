# Checklist — bybit / strategy_2

Exchange: **bybit**
Strategy: **strategy_2** (Retracement LONG — Retracement + Funding Fee Event Exit)
Spec: `docs-strategy/strategies/strategy_2.md`
Code: `src/execution/strategies/strategy_2.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/bybit.ts`

---

**Bybit-specific notes (CRITICAL):**
- WS entry via WS order adapter (requiresWsOrderAdapter=true)
- Bybit WS event timestamps are in **microseconds (μs)** → adapter divides by 1000 for ms
- Bybit echoes `clientOrderId` for both market and limit fills → normal WS routing
- Funding gate: Bybit wallet/position WS channel for funding event → `fundingGateOpen=true`
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_2.bybit.ORDER_LIFECYCLE.RETRACEMENT_EXIT_AFTER_FUNDING
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Bybit funding event opens fundingGate. Retracement tracker detects P_current >
    P_low × (1 + retracementPct/100). Market close (sell, reduceOnly) placed.
    SL cancelled via cancelSiblingExit.
  preconditions:
    - intent in monitoring, fundingGateOpen=true, P_current > P_low × threshold
  trigger_sequence:
    - Bybit wallet funding event → fundingGateOpen=true
    - retracementTracker price check passes → settle('retracement')
    - cancelSiblingExit(sl) → cancel SL → market close
  expected_behavior:
    - monitor.settle {reason: "retracement"} logged
    - oco.cancel.start for SL
    - order.placed {kind: "close", side: "sell", reduceOnly: true}
    - intent.exited.complete {exitReason: "retracement"}
  observability_contract:
    - log: 'monitor.settle' {reason: "retracement"}
    - log: 'oco.cancel.start' {clientOrderId: <slId>}
    - log: 'order.placed' {kind: "close"}
    - log: event='intent.funding_gate_closed' {intentId: "<id>", reason: "tp", durationMs: ">0"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (funding event handler)
    - src/execution/execution/manager.ts:1502 (cancelSiblingExit)
    - src/execution/execution/manager.ts:1660 (market close)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_2.bybit.ORDER_LIFECYCLE.SL_FILLS_RETRACEMENT_CANCELLED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    SL stop_market fills (long position). Bybit WS order fill for SL with clientOrderId
    (μs timestamp, adapter ÷1000). monitor.settle('sl'). Retracement tracker cancelled.
  preconditions:
    - intent in monitoring, price drops to SL stop price
  trigger_sequence:
    - Bybit WS: order {clientOrderId: <slId>, orderStatus: "Filled", updatedTime: <μs>}
    - adapter ÷1000 → ms; byEntryOrderId lookup → monitor.settle('sl')
  expected_behavior:
    - monitor.settle {reason: "sl"} logged
    - retracement tracker stopped
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'intent.exited.complete' {exitReason: "sl"}
    - log: event='intent.funding_gate_closed' {intentId: "<id>", reason: "sl", durationMs: ">0"}
    - db:fills createdAt in valid ms range
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
    - src/execution/execution/monitor.ts:124 (ws.order SL listener)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_2.bybit.ORDER_LIFECYCLE.DEADLINE_FALLBACK
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Neither retracement exit nor SL fill by deadlineAt. Deadline fires. SL cancelled.
    Market close placed.
  preconditions:
    - intent in monitoring at deadlineAt, no exit fired
  trigger_sequence:
    - monitor.settle('deadline') → cancel SL → market close
  expected_behavior:
    - monitor.settle {reason: "deadline"} logged
    - oco.cancel.start for SL
    - order.placed {kind: "close", side: "sell"}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'monitor.settle' {reason: "deadline"}
    - log: 'order.placed' {kind: "close"}
    - log: event='intent.funding_gate_closed' {intentId: "<id>", reason: "deadline", durationMs: ">0"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:115 (deadline timer)
    - src/execution/execution/manager.ts:1660 (market close)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_2.bybit.WEBSOCKET.RECONNECT_TRIGGERS_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    Bybit WS disconnects and reconnects while intent is in monitoring. store.reconcile
    called. wallet funding listener and retracement tracker survive reconnect (bus-based).
  preconditions:
    - intent in monitoring, Bybit WS disconnects and reconnects
  trigger_sequence:
    - ws.connection {state: "connected"} → store.reconcile('bybit')
  expected_behavior:
    - REST getOpenOrders + getPositions fetched
    - retracement tracker still active
    - no duplicate exit
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal)
    - log: event='ws.connection' {exchange: "bybit", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - position consistent after reconcile
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: occasional

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_2.bybit.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_2 intent is in monitoring on Bybit. Recovery
    rehydrates IntentState. manager.start() re-arms deadline monitor. spawnRetracementTracker
    is NOT re-called post-recovery. Deadline is only automatic exit path post-recovery;
    SL fill (via WS) can still trigger exit.
  preconditions:
    - intent in DB with status=monitoring
    - SL resting in Bybit order book
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - deadline monitor armed (retracement tracker not restarted)
    - wallet funding listener re-registered
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed' (debug)
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated states)
    - src/execution/execution/manager.ts:1888 (re-arm)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    spawnRetracementTracker NOT re-called after recovery. Deadline is the only
    automatic exit; SL WS fill can still fire.

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_2.bybit.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No Bybit WS call.
  preconditions:
    - kill switch mode != 'off', strategy_2 condition for bybit
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
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: occasional
```
