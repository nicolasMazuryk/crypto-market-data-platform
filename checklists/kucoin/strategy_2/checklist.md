# Checklist — kucoin / strategy_2

Exchange: **kucoin**
Strategy: **strategy_2** (Retracement LONG — Retracement + Funding Fee Event Exit)
Spec: `docs-strategy/strategies/strategy_2.md`
Code: `src/execution/strategies/strategy_2.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/kucoin.ts`

---

**KuCoin-specific notes (CRITICAL):**
- WS entry via WS order adapter (requiresWsOrderAdapter=true)
- KuCoin does NOT echo `clientOrderId` for market fills in WS events → `pollForEntryFill` is PRIMARY fill path
- Funding gate: `wallet.funding` WS channel → `fundingGateOpen=true`
- `cancelIgnoreCode: 100004` (order not found = success) for SL OCO cancel
- ms timestamps throughout
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_2.kucoin.ORDER_LIFECYCLE.ENTRY_PLACED_VIA_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. orderClient() resolves to WS
    adapter (requiresWsOrderAdapter=true). Market BUY placed via WS adapter.
    No clientOrderId transformation on KuCoin. pollForEntryFill started immediately
    as PRIMARY fill detection (KuCoin market fills lack clientOrderId in WS events).
    wallet.funding listener registered for fundingGateOpen. spawnRetracementTracker started.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - WS order adapter available for kucoin
  trigger_sequence:
    - scheduler fires at entryAt → manager.submit() → WS adapter createOrder
    - pollForEntryFill started immediately (PRIMARY)
    - wallet.funding WS listener registered
  expected_behavior:
    - intent.created logged (strategy=strategy_2, exchange=kucoin)
    - order.placed (kind=entry, side=buy, orderType=market) logged
    - pollForEntryFill running (PRIMARY for KuCoin)
    - status decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_2", exchange: "kucoin"}
    - log: 'order.placed' {kind: "entry", side: "buy", orderType: "market"}
    - db:orders {kind: "entry", status: "pending"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:90 (requiresWsOrderAdapter)
    - src/execution/execution/manager.ts:96 (orderClient → WS adapter)
    - src/execution/execution/manager.ts:2787 (pollForEntryFill start — PRIMARY)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    KuCoin WS market fills lack clientOrderId → pollForEntryFill (15×1s REST) is PRIMARY.

- id: strategy_2.kucoin.ORDER_LIFECYCLE.ENTRY_FILLED_REST_POLL
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    PRIMARY fill detection on KuCoin. pollForEntryFill (15×1s REST getOrder by
    exchangeOrderId) detects fill. handleEntryFilled called → position.opened.
    SL (stop_market, sell, reduceOnly) placed immediately via REST.
    spawnRetracementTracker watches P_low. TERMINAL guard prevents double-processing.
  preconditions:
    - entry order placed (working), KuCoin REST accessible
  trigger_sequence:
    - pollForEntryFill: getOrder(exchangeOrderId) returns status=filled
    - handleEntryFilled: SL placed, spawnRetracementTracker running
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice from REST)
    - position.opened logged (side=long)
    - order.placed {kind: "sl", side: "sell", orderType: "stop_market"} logged
    - retracement tracker active; wallet.funding listener watches for fundingGateOpen
    - status working → filled → monitoring
  observability_contract:
    - log: 'order.filled' {exchange: "kucoin", filledQty: ">0"}
    - log: 'position.opened' {side: "long"}
    - log: 'order.placed' {kind: "sl"}
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — PRIMARY)
    - src/execution/execution/manager.ts:782 (position.opened)
    - src/execution/execution/manager.ts:406 (handleEntryFilled SL placement)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_2.kucoin.ORDER_LIFECYCLE.RETRACEMENT_EXIT_AFTER_FUNDING
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    wallet.funding event opens fundingGate. Retracement tracker detects P_current >
    P_low × (1 + retracementPct/100). Market close (sell, reduceOnly) placed.
    SL cancelled (cancelIgnoreCode=100004).
  preconditions:
    - intent in monitoring, fundingGateOpen=true, P_current > P_low × threshold
  trigger_sequence:
    - wallet.funding event → fundingGateOpen=true
    - retracementTracker price check passes → settle('retracement')
    - cancelSiblingExit(sl) → cancel SL (100004 OK) → market close
  expected_behavior:
    - monitor.settle {reason: "retracement"} logged
    - oco.cancel.start for SL (100004 = success)
    - order.placed {kind: "close", side: "sell", reduceOnly: true}
    - intent.exited.complete {exitReason: "retracement"}
  observability_contract:
    - log: 'monitor.settle' {reason: "retracement"}
    - log: 'oco.cancel.start' {clientOrderId: <slId>}
    - log: 'order.placed' {kind: "close"}
    - log: event='intent.funding_gate_closed' {intentId: "<id>", reason: "tp", durationMs: ">0"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (wallet.funding → fundingGateOpen)
    - src/execution/execution/manager.ts:1502 (cancelSiblingExit)
    - src/execution/execution/manager.ts:1660 (market close)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_2.kucoin.ORDER_LIFECYCLE.SL_FILLS_RETRACEMENT_CANCELLED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    SL stop_market fills before retracement exit. KuCoin WS 'orders' channel emits
    fill for SL (non-market order — clientOrderId IS echoed by KuCoin for stop orders).
    byEntryOrderId lookup succeeds. monitor.settle('sl'). Retracement tracker cancelled.
  preconditions:
    - intent in monitoring, price drops to SL stop price
  trigger_sequence:
    - KuCoin WS: orders {status: "filled", clientOrderId: <slId>}
    - byEntryOrderId lookup → monitor.settle('sl')
    - retracement tracker cancelled
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

- id: strategy_2.kucoin.ORDER_LIFECYCLE.DEADLINE_FALLBACK
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Neither retracement exit nor SL fill by deadlineAt. Deadline fires.
    SL cancelled (100004 OK). Market close placed.
  preconditions:
    - intent in monitoring at deadlineAt, no exit fired
  trigger_sequence:
    - monitor.settle('deadline') → cancel SL (100004 OK) → market close
  expected_behavior:
    - monitor.settle {reason: "deadline"} logged
    - oco.cancel.start for SL (100004 = success)
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

- id: strategy_2.kucoin.TIMING.FUNDING_GATE_OPENS_VIA_WALLET_FUNDING
  category: TIMING
  severity: critical
  description: >
    At T_f, KuCoin emits wallet.funding WS event. Adapter maps to internal bus.
    fundingGateOpen set true. Retracement tracker now armed to fire on first
    qualifying price level.
  preconditions:
    - intent in monitoring, KuCoin wallet.funding event received at T_f
  trigger_sequence:
    - KuCoin WS: wallet.funding {contract: <symbol>}
    - adapter → fundingGateOpen=true
  expected_behavior:
    - funding gate opens; retracement exit can now fire
  observability_contract:
    - log: event='intent.funding_gate_opened' {intentId: "<id>", openedAt: ">0", fundingTs: ">0"}
    - retracement.exit fires only after gate opens
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (wallet.funding handler)
    - src/execution/strategies/strategy_2.ts (fundingGateOpen logic)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_2.kucoin.WEBSOCKET.KUCOIN_MARKET_FILL_NO_CLIENT_ORDER_ID
  category: WEBSOCKET
  severity: critical
  description: >
    KuCoin WS 'orders' channel emits fill for the entry market order WITHOUT
    clientOrderId. byEntryOrderId lookup FAILS silently. pollForEntryFill
    (already running as PRIMARY) detects fill via REST within 1-15s.
    SL placement is delayed by fill detection latency.
  preconditions:
    - entry market order placed via WS adapter (working)
    - KuCoin WS emits fill without clientOrderId
  trigger_sequence:
    - KuCoin WS: orders {clientOrderId: null/absent, orderId: <exchangeOrderId>}
    - byEntryOrderId lookup misses
    - pollForEntryFill: REST getOrder → filled → handleEntryFilled
  expected_behavior:
    - WS fill NOT routed (no order.filled log from WS path)
    - pollForEntryFill detects fill within 1-15s
    - SL placed after poll detects fill
    - TERMINAL guard prevents double-processing
  observability_contract:
    - log: 'order.filled' from REST poll (not WS event)
    - NO error for unrouted KuCoin WS fill event
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (market fill: clientOrderId absent)
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — PRIMARY)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_2.kucoin.WEBSOCKET.RECONNECT_TRIGGERS_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    KuCoin WS disconnects and reconnects while intent is in monitoring.
    store.reconcile called. wallet.funding listener and retracement tracker
    survive reconnect (bus-based). SL still resting.
  preconditions:
    - intent in monitoring, KuCoin WS disconnects and reconnects
  trigger_sequence:
    - ws.connection {state: "connected"} → store.reconcile('kucoin')
  expected_behavior:
    - REST getOpenOrders + getPositions fetched
    - wallet.funding listener still registered
    - retracement tracker still active
    - no duplicate exit
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal)
    - log: event='ws.connection' {exchange: "kucoin", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - position consistent after reconcile
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: occasional

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_2.kucoin.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_2 intent is in monitoring on KuCoin. Recovery
    rehydrates IntentState. manager.start() re-arms deadline monitor. spawnRetracementTracker
    is NOT re-called post-recovery. Deadline is the only automatic exit path post-recovery;
    SL fill (via WS) can still trigger exit if price drops. cancelIgnoreCode=100004 for
    SL orphan cancel during recovery.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=sl_tp_deadline_retracement_funding_event
    - SL resting in KuCoin order book
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - deadline monitor armed (retracement tracker not restarted)
    - wallet.funding listener re-registered
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed' (debug)
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated states)
    - src/execution/execution/manager.ts:1888 (re-arm — deadline only)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    spawnRetracementTracker is NOT re-called after process recovery. Deadline is
    the only automatic exit path post-recovery; SL fill via WS can still fire.

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_2.kucoin.SPEC_DIVERGENCE.KUCOIN_POLL_AS_PRIMARY_FILL_PATH
  category: SPEC_DIVERGENCE
  severity: critical
  description: >
    Spec assumes WS fill routing (via clientOrderId) is primary. KuCoin market
    order WS fills lack clientOrderId. pollForEntryFill is PRIMARY for KuCoin.
    SL placement delayed 1-15s after actual fill (brief unprotected window).
  preconditions:
    - strategy_2 intent submitted for kucoin, entry fills
  trigger_sequence:
    - KuCoin WS fill: no clientOrderId → not routed
    - pollForEntryFill: REST detects fill within 1-15s
  expected_behavior:
    - SL placed 1-15s after actual fill (vs immediate on other exchanges)
    - brief window: position open, SL not yet placed
  observability_contract:
    - log: 'order.filled' from REST poll (NOT WS routing)
    - no error for unrouted KuCoin WS fill events
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (market fill: no clientOrderId)
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — PRIMARY)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_2.kucoin.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No KuCoin WS call.
  preconditions:
    - kill switch mode != 'off', strategy_2 condition for kucoin
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
