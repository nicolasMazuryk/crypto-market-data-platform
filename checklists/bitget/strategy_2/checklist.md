# Checklist — bitget / strategy_2

Exchange: **bitget**
Strategy: **strategy_2** (Retracement LONG — Retracement + Funding Fee Event Exit)
Spec: `docs-strategy/strategies/strategy_2.md`
Code: `src/execution/strategies/strategy_2.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/bitget.ts`

---

**Bitget-specific notes:**

- WS entry via WS order adapter (requiresWsOrderAdapter=true)
- Bitget 'orders' WS channel for fill events; timestamps in ms (no conversion)
- Bitget echoes `clientOrderId` → WS routing is primary
- Funding gate: Bitget account/position WS channel → `fundingGateOpen=true`
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_2.bitget.ORDER_LIFECYCLE.ENTRY_PLACED_VIA_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. orderClient() resolves to WS
    adapter. Market BUY placed via WS adapter. Bitget echoes clientOrderId in WS
    fills → WS routing is primary. pollForEntryFill started as backup.
    Account listener registered for fundingGateOpen. spawnRetracementTracker started.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - WS order adapter available for bitget
  trigger_sequence:
    - scheduler fires at entryAt → manager.submit() → WS adapter createOrder
    - pollForEntryFill started (backup)
    - spawnRetracementTracker started
  expected_behavior:
    - intent.created logged (strategy=strategy_2, exchange=bitget)
    - order.placed (kind=entry, side=buy, orderType=market) logged
    - status decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_2", exchange: "bitget"}
    - log: 'order.placed' {kind: "entry", side: "buy", orderType: "market"}
    - db:orders {kind: "entry", status: "pending"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:90 (requiresWsOrderAdapter)
    - src/execution/execution/manager.ts:96 (orderClient → WS adapter)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_2.bitget.ORDER_LIFECYCLE.ENTRY_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Bitget WS 'orders' event with clientOrderId (ms timestamp). byEntryOrderId lookup
    succeeds. handleEntryFilled → position.opened (long). SL (stop_market, sell,
    reduceOnly) placed immediately. spawnRetracementTracker active.
  preconditions:
    - entry order placed (working), Bitget WS connected
  trigger_sequence:
    - Bitget WS: orders {clientOrderId: <id>, status: "full-fill"}
    - byEntryOrderId lookup → handleEntryFilled
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice, ms timestamps)
    - position.opened logged (side=long)
    - order.placed {kind: "sl"} logged
    - status working → filled → monitoring
  observability_contract:
    - log: 'order.filled' {exchange: "bitget", filledQty: ">0"}
    - log: 'position.opened' {side: "long"}
    - log: 'order.placed' {kind: "sl"}
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:1140 (handleEntryOrderEvent)
    - src/execution/execution/manager.ts:406 (handleEntryFilled SL placement)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_2.bitget.ORDER_LIFECYCLE.RETRACEMENT_EXIT_AFTER_FUNDING
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Bitget account/position event opens fundingGate. Retracement tracker detects
    P_current > P_low × (1 + retracementPct/100). Market close placed. SL cancelled.
  preconditions:
    - intent in monitoring, fundingGateOpen=true, P_current > P_low × threshold
  trigger_sequence:
    - Bitget account/position funding event → fundingGateOpen=true
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
    - src/execution/adapters/privatews/bitget.ts (account funding handler)
    - src/execution/execution/manager.ts:1502 (cancelSiblingExit)
    - src/execution/execution/manager.ts:1660 (market close)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_2.bitget.ORDER_LIFECYCLE.SL_FILLS_RETRACEMENT_CANCELLED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    SL stop_market fills before retracement exit. Bitget WS 'orders' emits fill
    for SL with clientOrderId. monitor.settle('sl'). Retracement tracker cancelled.
  preconditions:
    - intent in monitoring, price drops to SL stop price
  trigger_sequence:
    - Bitget WS: orders {clientOrderId: <slId>, status: "full-fill"}
    - byEntryOrderId lookup → monitor.settle('sl')
  expected_behavior:
    - monitor.settle {reason: "sl"} logged
    - retracement tracker stopped
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'intent.exited.complete' {exitReason: "sl"}
    - log: event='intent.funding_gate_closed' {intentId: "<id>", reason: "sl", durationMs: ">0"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:124 (ws.order SL listener)
    - src/execution/execution/manager.ts:1502 (cancel retracement tracker)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_2.bitget.ORDER_LIFECYCLE.DEADLINE_FALLBACK
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Neither retracement exit nor SL fill by deadlineAt. Deadline fires.
    SL cancelled. Market close placed.
  preconditions:
    - intent in monitoring at deadlineAt, no exit fired
  trigger_sequence:
    - monitor.settle('deadline') → cancel SL → market close
  expected_behavior:
    - monitor.settle {reason: "deadline"} logged
    - oco.cancel.start for SL
    - order.placed {kind: "close"}
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

- id: strategy_2.bitget.TIMING.FUNDING_GATE_OPENS_VIA_ACCOUNT_EVENT
  category: TIMING
  severity: critical
  description: >
    At T_f, Bitget emits an account/position WS event indicating funding fee.
    fundingGateOpen set true. Retracement tracker armed to fire on qualifying price.
  preconditions:
    - intent in monitoring, Bitget account funding event received at T_f
  trigger_sequence:
    - Bitget WS: account/position funding event → fundingGateOpen=true
  expected_behavior:
    - funding gate opens; retracement exit can now fire
  observability_contract:
    - log: event='intent.funding_gate_opened' {intentId: "<id>", openedAt: ">0", fundingTs: ">0"}
    - retracement.exit fires only after gate opens
  code_refs:
    - src/execution/adapters/privatews/bitget.ts (account funding handler)
    - src/execution/strategies/strategy_2.ts (fundingGateOpen logic)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_2.bitget.WEBSOCKET.RECONNECT_TRIGGERS_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    Bitget WS disconnects and reconnects while intent is in monitoring. store.reconcile
    called. Account funding listener and retracement tracker survive reconnect.
  preconditions:
    - intent in monitoring, Bitget WS disconnects and reconnects
  trigger_sequence:
    - ws.connection {state: "connected"} → store.reconcile('bitget')
  expected_behavior:
    - REST getOpenOrders + getPositions fetched
    - retracement tracker still active
    - no duplicate exit
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal)
    - log: event='ws.connection' {exchange: "bitget", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - position consistent after reconcile
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: occasional

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_2.bitget.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_2 intent is in monitoring on Bitget. Recovery
    rehydrates IntentState. manager.start() re-arms deadline monitor. spawnRetracementTracker
    NOT re-called. Deadline is only automatic exit path post-recovery.
  preconditions:
    - intent in DB with status=monitoring
    - SL resting in Bitget order book
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - deadline monitor armed (retracement tracker not restarted)
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
    spawnRetracementTracker NOT re-called after recovery. Deadline and SL WS fill
    are only exit paths post-recovery.

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_2.bitget.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No Bitget WS call.
  preconditions:
    - kill switch mode != 'off', strategy_2 condition for bitget
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
