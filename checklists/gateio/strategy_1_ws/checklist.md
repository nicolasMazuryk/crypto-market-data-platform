# Checklist — gateio / strategy_1_ws

Exchange: **gateio**
Strategy: **strategy_1_ws** (Negative Funding LONG — Funding-Fee Event Exit)
Spec: `docs-strategy/strategies/strategy_1_ws.md`
Code: `src/execution/strategies/strategy_1_ws.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/gateio.ts`

---

**GateIO-specific notes:**
- WS entry via WS order adapter (requiresWsOrderAdapter=true)
- Private WS: `futures.orders` channel for order fills; timestamps in **seconds** (× 1000 for ms)
- Funding fee events: GateIO private WS on `account.book` or similar channel with fund-related bizType
- `cancelIgnoreCode: 'TEXT_DUPLICATED'` treated as cancel success
- Symbol normalization in recovery (`recovery.ts:302-305`)
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_1_ws.gateio.ORDER_LIFECYCLE.ENTRY_PLACED_VIA_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. orderClient() resolves to the
    WS order adapter (requiresWsOrderAdapter('strategy_1_ws')=true). A market BUY is
    placed via the WS adapter. No clientOrderId transformation on GateIO. order.placed
    logged with kind=entry, side=buy, orderType=market, reduceOnly=false.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - WS order adapter connected for gateio
  trigger_sequence:
    - scheduler fires at entryAt = nextFundingTimestamp - entryOffsetSeconds*1000
    - manager.submit() → WS adapter createOrder
  expected_behavior:
    - intent.created logged (strategy=strategy_1_ws, exchange=gateio)
    - intent.submitted logged (entryKind=market)
    - WS adapter createOrder called (NOT REST)
    - order.placed logged (kind=entry, side=buy, orderType=market, reduceOnly=false)
    - status transitions decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_1_ws", exchange: "gateio"}
    - log: 'intent.submitted' {entryKind: "market"}
    - log: 'order.placed' {kind: "entry", side: "buy", orderType: "market", reduceOnly: false}
    - db:orders row {kind: "entry", orderType: "market", status: "pending"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:90 (requiresWsOrderAdapter — true for strategy_1_ws)
    - src/execution/execution/manager.ts:96 (orderClient returns WS adapter)
    - src/execution/execution/manager.ts:2008 (intent.created log)
    - src/execution/execution/manager.ts:2755 (order.placed log)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (WS order adapter required)
  status: ⏳
  natural_occurrence: routine
  notes: >
    GateIO WS adapter uses the GateIO futures private WS for order placement.
    No clientOrderId dash-stripping needed (GateIO accepts standard format).

- id: strategy_1_ws.gateio.ORDER_LIFECYCLE.ENTRY_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Entry market order fills. GateIO private WS 'futures.orders' channel emits fill
    event. GateIO WS timestamps are in SECONDS — adapter multiplies by 1000. Manager
    routes via byEntryOrderId lookup (clientOrderId match), logs order.filled, transitions
    to filled, calls handleEntryFilled → position.opened + monitor.armed.funding_fee_event.
  preconditions:
    - entry order placed (status=working)
    - GateIO private WS connected
  trigger_sequence:
    - GateIO WS: 'futures.orders' {status: "filled", text: <clientOrderId>, create_time: <seconds>}
    - adapter: ts_ms = create_time * 1000
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice present, correct ms timestamps in DB)
    - status transitions working → filled → monitoring
    - position.opened logged (side=long)
    - monitor.armed.funding_fee_event logged (debug)
    - no SL/TP placed
  observability_contract:
    - log: 'order.filled' {exchange: "gateio", filledQty: ">0"}
    - log: 'position.opened' {side: "long"}
    - log: 'monitor.armed.funding_fee_event' {timeoutDelay, fundingTs}
    - db:fills createdAt: in correct ms range (>1700000000000)
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/adapters/privatews/gateio.ts (futures.orders channel — ts * 1000)
    - src/execution/execution/manager.ts:1156 (order.filled log)
    - src/execution/execution/manager.ts:782 (position.opened log)
    - src/execution/execution/monitor.ts:210 (monitor.armed.funding_fee_event debug log)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (Entry fill → arm funding_fee_event monitor)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Critical: GateIO timestamps are seconds. If the adapter omits * 1000, DB timestamps
    are ~1970-01-01 and monitor timing may be incorrect. Verify adapter timestamp conversion.

- id: strategy_1_ws.gateio.ORDER_LIFECYCLE.CLOSE_WS_REJECTED_REST_FALLBACK
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Monitor exit fires. WS adapter returns rejected for close order. Manager logs
    close.ws_rejected and retries via REST createOrder. REST close succeeds.
  preconditions:
    - intent in monitoring, WS adapter rejects close order
  trigger_sequence:
    - monitor.settle → handleMonitorExit → WS adapter createOrder → {status: 'rejected'}
    - REST fallback createOrder called
  expected_behavior:
    - close.ws_rejected logged (error level)
    - REST close placed
    - order.placed {kind: "close", side: "sell", reduceOnly: true}
    - intent exits normally
  observability_contract:
    - log: 'close.ws_rejected' {rejectReason}
    - log: 'order.placed' {kind: "close"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/manager.ts:1620 (ws_rejected check)
    - src/execution/execution/manager.ts:1622 (close.ws_rejected log)
    - src/execution/execution/manager.ts:1625 (REST fallback)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_1_ws.gateio.TIMING.FUNDING_FEE_EVENT_EXIT
  category: TIMING
  severity: critical
  description: >
    At T_f, GateIO emits a funding fee credit event on the private WS (account.book
    or equivalent channel). The GateIO WS adapter maps this to ws.funding_fee on the
    bus. The monitor listener matches by exchange, symbol, and ±5000ms timestamp tolerance.
    settle('funding_fee') fires. Manager places market close.
  preconditions:
    - intent in monitoring
    - GateIO emits funding fee WS event at T_f for the correct symbol
  trigger_sequence:
    - GateIO WS: account.book funding event {bizType: <fund-related>, contract: <symbol>}
    - adapter → bus.emit('ws.funding_fee', {exchange: "gateio", symbol, fundingTime})
    - monitor listener matches → settle('funding_fee')
  expected_behavior:
    - monitor.exit_requested logged
    - monitor.settle {reason: "funding_fee", source: "ws"} logged
    - intent.exiting.start {reason: "funding_fee"} logged
    - order.placed {kind: "close", side: "sell", reduceOnly: true}
    - intent exits
  observability_contract:
    - log: 'monitor.exit_requested' {reason: "funding_fee"}
    - log: 'monitor.settle' {reason: "funding_fee", source: "ws", latencyMs: "<5000"}
    - log: 'order.placed' {kind: "close", side: "sell", reduceOnly: true}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/adapters/privatews/gateio.ts (account.book / funding fee handler)
    - src/execution/execution/monitor.ts:198 (bus.on ws.funding_fee listener)
    - src/execution/execution/monitor.ts:200 (symbol + timestamp filter)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (Exit: ws.funding_fee within ±5s)
  status: ⏳
  natural_occurrence: routine
  notes: >
    GateIO funding fee WS channel and event format must be verified against GateIO
    private WS API docs. The adapter must convert timestamps from seconds to ms before
    emitting the bus event. Symbol in the event must be normalized (BTC_USDT → BTCUSDT).

- id: strategy_1_ws.gateio.TIMING.FUNDING_FEE_TIMEOUT
  category: TIMING
  severity: high
  description: >
    ws.funding_fee not received before timeoutAt. Timeout timer fires.
    settle('funding_fee_timeout'). Market close placed.
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
    - docs-strategy/strategies/strategy_1_ws.md (Timeout fallback)
  status: ⏳
  natural_occurrence: occasional

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_1_ws.gateio.WEBSOCKET.RECONNECT_TRIGGERS_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    GateIO private WS disconnects and reconnects while intent is in monitoring.
    store.reconcile() called on reconnect. REST fetches open orders and positions.
    ws.funding_fee bus listener re-created at arm time remains active.
  preconditions:
    - intent in monitoring, waiting for ws.funding_fee
    - WS disconnects then reconnects
  trigger_sequence:
    - ws.connection {state: "disconnected"} then {state: "connected"}
    - store.reconcile('gateio') called
  expected_behavior:
    - REST getOpenOrders + getPositions fetched
    - funding_fee_event monitor remains armed (bus listener active)
    - no duplicate exit
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal)
    - log: event='ws.connection' {exchange: "gateio", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - position consistent after reconcile
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_1_ws.gateio.WEBSOCKET.WS_ADAPTER_MISSING
  category: WEBSOCKET
  severity: critical
  description: >
    No WS order adapter registered for gateio. orderClient() throws. Intent errors.
    No REST fallback for entry on strategy_1_ws.
  preconditions:
    - strategy_1_ws submitted for gateio
    - no WS adapter registered for gateio
  trigger_sequence:
    - orderClient('gateio', 'strategy_1_ws') throws
  expected_behavior:
    - intent.error logged
    - no order.placed
  observability_contract:
    - log: 'intent.error' {code: "no_adapter" or thrown error}
    - db:intentLifecycleEvents →error
  code_refs:
    - src/execution/execution/manager.ts:97 (requiresWsOrderAdapter check)
    - src/execution/execution/manager.ts:100 (throws if missing)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: rare

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_1_ws.gateio.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_1_ws intent is in monitoring on GateIO.
    Recovery rehydrates IntentState. manager.start() re-arms funding_fee_event monitor.
    GateIO symbol normalization applied at recovery.ts:302-305.
    If timeoutAt is past, timer fires immediately (delay=0).
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=funding_fee_event
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor.armed.funding_fee_event logged with new timeoutDelay
    - if timeoutAt past: settle('funding_fee_timeout') fires immediately
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.funding_fee_event' {timeoutDelay: ">=0"}
  code_refs:
    - src/execution/recovery/index.ts:302 (GateIO symbol normalization)
    - src/execution/recovery/index.ts:245 (rehydrated states log)
    - src/execution/execution/manager.ts:1888 (start — re-arm)
    - src/execution/execution/monitor.ts:183 (funding_fee_event arm)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_1_ws.gateio.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active at submit time. Preflight rejects with code=kill_switch.
    No GateIO WS adapter call made.
  preconditions:
    - kill switch mode != 'off'
    - strategy_1_ws condition met for gateio
  trigger_sequence:
    - manager.submit() → preflight → kill_switch
  expected_behavior:
    - intent.error {code: "kill_switch"} logged
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

- id: strategy_1_ws.gateio.SPEC_DIVERGENCE.GATEIO_TIMESTAMP_SECONDS
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    GateIO WS events use SECOND-precision timestamps. Spec assumes millisecond timestamps.
    The GateIO WS adapter must convert all timestamps: ts_ms = raw_ts * 1000.
    If not applied, fill timestamps in DB are off by ×1000, and funding_fee event
    matching (±5000ms tolerance) may fail if fundingTime is compared in seconds vs ms.
  preconditions:
    - GateIO WS adapter processing futures.orders or account.book events
  trigger_sequence:
    - GateIO WS event: {create_time: <seconds>, ...}
    - adapter: ts_ms = create_time * 1000
  expected_behavior:
    - all timestamps processed in ms
    - ws.funding_fee bus event: fundingTime in ms
    - monitor.ts:201 tolerance check (±5000ms) works correctly
  observability_contract:
    - db:fills createdAt: > 1700000000000 (valid ms range)
    - log: 'monitor.settle' latencyMs measurable (not negative or >1e12)
  code_refs:
    - src/execution/adapters/privatews/gateio.ts (timestamp conversion)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (no mention of timestamp units)
  status: ⏳
  natural_occurrence: routine
  notes: >
    This is a systemic GateIO risk. Every new GateIO WS channel integration must
    verify timestamp units. One missed * 1000 causes silent data corruption.
```
