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

- id: strategy_2.bybit.ORDER_LIFECYCLE.ENTRY_PLACED_VIA_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. orderClient() resolves to WS
    adapter. Market BUY placed via WS adapter. Bybit echoes clientOrderId in WS
    fill events → WS routing is primary. pollForEntryFill started as backup.
    wallet/position listener registered for fundingGateOpen. spawnRetracementTracker
    started.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - WS order adapter available for bybit
  trigger_sequence:
    - scheduler fires at entryAt → manager.submit() → WS adapter createOrder
    - pollForEntryFill started (backup)
    - spawnRetracementTracker started
  expected_behavior:
    - intent.created logged (strategy=strategy_2, exchange=bybit)
    - order.placed (kind=entry, side=buy, orderType=market) logged
    - status decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_2", exchange: "bybit"}
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

- id: strategy_2.bybit.ORDER_LIFECYCLE.ENTRY_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Bybit WS order fill event arrives with clientOrderId (μs timestamp, adapter ÷1000).
    byEntryOrderId lookup succeeds. handleEntryFilled → position.opened (long). SL
    (stop_market, sell, reduceOnly) placed immediately. spawnRetracementTracker active.
    TERMINAL guard prevents double-processing if pollForEntryFill also fires.
  preconditions:
    - entry order placed (working), Bybit WS connected
  trigger_sequence:
    - Bybit WS: order {clientOrderId: <id>, orderStatus: "Filled", updatedTime: <μs>}
    - adapter: updatedTime / 1000 → ms
    - byEntryOrderId lookup → handleEntryFilled
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice, ms timestamps)
    - position.opened logged (side=long)
    - order.placed {kind: "sl", side: "sell", orderType: "stop_market"} logged
    - status working → filled → monitoring
  observability_contract:
    - log: 'order.filled' {exchange: "bybit", filledQty: ">0"}
    - log: 'position.opened' {side: "long"}
    - log: 'order.placed' {kind: "sl"}
    - db:fills createdAt in valid ms range (not μs range)
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
    - src/execution/execution/manager.ts:1140 (handleEntryOrderEvent)
    - src/execution/execution/manager.ts:406 (handleEntryFilled SL placement)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    Bybit WS timestamps in microseconds. adapter ÷ 1000 converts to ms.
    db:fills.createdAt must be in ms range (> 1700000000000), not μs range.

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

- id: strategy_2.bybit.TIMING.FUNDING_GATE_OPENS_VIA_WALLET_EVENT
  category: TIMING
  severity: critical
  description: >
    At T_f, Bybit emits a wallet/position WS event indicating funding fee received.
    fundingGateOpen set true. Retracement tracker now armed to fire on first qualifying
    price level.
  preconditions:
    - intent in monitoring, Bybit funding event received at T_f
  trigger_sequence:
    - Bybit WS: funding event → fundingGateOpen=true
  expected_behavior:
    - funding gate opens; retracement exit can now fire
  observability_contract:
    - log: event='intent.funding_gate_opened' {intentId: "<id>", openedAt: ">0", fundingTs: ">0"}
    - retracement.exit fires only after gate opens
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (funding event handler)
    - src/execution/strategies/strategy_2.ts (fundingGateOpen logic)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_2.bybit.WEBSOCKET.BYBIT_MICROSECOND_TIMESTAMPS
  category: WEBSOCKET
  severity: critical
  description: >
    Bybit private WS order events carry `updatedTime` in microseconds (μs).
    Adapter must divide by 1000 for ms before emitting. If not converted, all
    db:fills timestamps will be in μs range (too large by factor 1000) causing
    timestamp consistency failures.
  preconditions:
    - Bybit WS order fill events processed (entry, SL, TP fills)
  trigger_sequence:
    - Bybit WS: order {updatedTime: <μs value>}
    - adapter: updatedTime / 1000 → ms
  expected_behavior:
    - db:fills createdAt in valid ms range (> 1700000000000, < 2000000000000)
    - NOT in μs range (> 1700000000000000)
  observability_contract:
    - db:fills createdAt > 1700000000000 AND < 2000000000000 for all bybit rows
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine

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

- id: strategy_2.bybit.SPEC_DIVERGENCE.BYBIT_MICROSECOND_TIMESTAMPS
  category: SPEC_DIVERGENCE
  severity: critical
  description: >
    Spec and internal timestamps are in ms. Bybit WS events carry μs timestamps.
    Adapter divide-by-1000 is mandatory. Without it, all fill timestamps will be
    1000× too large, corrupting db:fills and invalidating time-based comparisons.
  preconditions:
    - any Bybit WS order fill event processed
  trigger_sequence:
    - Bybit WS: order {updatedTime: <μs>}
    - adapter: updatedTime / 1000 → ms
  expected_behavior:
    - all timestamps stored as ms throughout
  observability_contract:
    - db:fills createdAt in ms range for all bybit rows
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine

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
