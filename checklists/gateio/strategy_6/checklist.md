# Checklist — gateio / strategy_6

Exchange: **gateio**
Strategy: **strategy_6** (Post-Funding Directional — WS-Gated Entry)
Spec: `docs-strategy/strategies/strategy_6.md`
Code: `src/execution/strategies/strategy_6.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/gateio.ts`

> **Note:** strategy_6 is LIVE-ONLY. No backtest support.
> MAIN and PRE_FUNDING orders use WS order adapter (requiresWsOrderAdapter('strategy_6')=true).
> GateIO WS timestamps in **seconds** — adapter × 1000 for ms.
> GateIO funding fee events on account.book-like channel with fund-related bizType.
> `cancelIgnoreCode: 'TEXT_DUPLICATED'` for OCO cancels.

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_6.gateio.ORDER_LIFECYCLE.PRE_FUNDING_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    At T_f - 10s, manager.submit() is called. A tiny market order (preFundingSide,
    preFundingVolume = computeMinOrderQty) is placed via the WS order adapter.
    No clientOrderId transformation on GateIO. preFundingId registered in
    byEntryOrderId. Intent transitions acked → working. ws.funding_fee bus listener
    registered. timeoutHandle set at timeoutAt.
  preconditions:
    - funding_threshold check passed
    - market.status = trading
    - kill switch inactive
    - WS order adapter available for gateio
  trigger_sequence:
    - scheduler fires at entryAt = nextFundingTimestamp - 10000ms
    - manager.submit() → pre_funding_then_main branch → WS adapter createOrder
  expected_behavior:
    - intent.created logged (strategy=strategy_6, exchange=gateio)
    - intent.submitted logged (entryKind=pre_funding_then_main)
    - order.placed (kind=pre_funding) logged
    - strategy6.pre_funding_placed logged with qty
    - status decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_6", exchange: "gateio"}
    - log: 'intent.submitted' {entryKind: "pre_funding_then_main"}
    - log: 'order.placed' {kind: "pre_funding", orderType: "market"}
    - log: 'strategy6.pre_funding_placed' {qty: "<min lot>"}
    - db:orders {kind: "pre_funding", status: "pending"}
    - db:orders {kind: "pre_funding", intentId: "<id>", exchange: "gateio"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:2098 (pre_funding_then_main branch)
    - src/execution/execution/manager.ts:2334 (WS adapter createOrder — pre_funding)
    - src/execution/execution/manager.ts:2367 (order.placed emit)
    - src/execution/execution/manager.ts:2379 (strategy6.pre_funding_placed log)
    - src/execution/execution/manager.ts:91 (requiresWsOrderAdapter — strategy_6)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 1)
  status: ⏳
  natural_occurrence: routine
  notes: >
    GateIO WS order adapter uses GateIO futures private WS. No clientOrderId dash-stripping.
    GateIO pre_funding fill arrives on 'futures.orders' WS channel with SECOND timestamps
    (adapter × 1000 required).

- id: strategy_6.gateio.ORDER_LIFECYCLE.PRE_FUNDING_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Pre-funding tiny market order fills. GateIO 'futures.orders' WS emits fill
    (SECOND timestamps, adapter × 1000). Manager detects isPreFunding=true,
    logs strategy6.pre_funding_filled, stores preFundingFilledQty. Intent stays in working.
  preconditions:
    - pre-funding order placed (working), GateIO futures.orders WS active
  trigger_sequence:
    - GateIO WS: futures.orders {status: "filled", text: <preFundingId>, create_time: <s>}
    - adapter × 1000
  expected_behavior:
    - strategy6.pre_funding_filled logged (filledQty = min lot)
    - s.preFundingFilledQty set
    - intent stays in working state
    - no SL/TP yet
  observability_contract:
    - log: 'strategy6.pre_funding_filled' {filledQty: "<min lot>", exchange: "gateio"}
    - db:fills createdAt in valid ms range
    - db:intentLifecycleEvents NO transition
  code_refs:
    - src/execution/adapters/privatews/gateio.ts (futures.orders — ts * 1000)
    - src/execution/execution/manager.ts:1097 (isPreFunding detection)
    - src/execution/execution/manager.ts:1104 (preFundingFilledQty set)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 1 fill)
  status: ⏳
  natural_occurrence: routine

- id: strategy_6.gateio.ORDER_LIFECYCLE.FUNDING_FEE_GATES_MAIN_ORDER
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    GateIO emits funding fee event on account.book (or equivalent) channel at T_f.
    GateIO WS adapter maps to ws.funding_fee bus event (timestamp × 1000). Bus listener
    in pre_funding path matches by exchange/symbol/fundingTime (±5s). MAIN order
    placed via WS adapter. preFundingFilledQty deducted from mainQty.
  preconditions:
    - pre-funding filled, waiting for ws.funding_fee
    - GateIO account.book funding event received
  trigger_sequence:
    - GateIO WS: account.book {bizType: <fund-related>, contract: <symbol>, create_time: <s>}
    - adapter → bus.emit('ws.funding_fee', {exchange: "gateio", symbol, fundingTime: ts*1000})
    - bus.on('ws.funding_fee') → MAIN order placed via WS adapter
  expected_behavior:
    - ws.funding_fee matched (exchange + symbol + ±5s)
    - strategy6.main_placed logged
    - order.placed (kind=main) logged
    - timeoutHandle cleared
  observability_contract:
    - log: 'strategy6.main_placed' {qty: "<mainQty - preFundingFilledQty>", exchange: "gateio"}
    - log: 'order.placed' {kind: "main", orderType: "market"}
    - db:orders {kind: "main", status: "pending"}
  code_refs:
    - src/execution/execution/manager.ts:2204 (bus.on ws.funding_fee → MAIN)
    - src/execution/execution/manager.ts:2240 (MAIN via WS adapter)
    - src/execution/adapters/privatews/gateio.ts (account.book → ws.funding_fee, ts*1000)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 2)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Verify GateIO's exact account.book event format and bizType string for funding fees.
    Timestamp must be × 1000 before the ±5000ms monitor tolerance check applies.

- id: strategy_6.gateio.ORDER_LIFECYCLE.MAIN_FILLED_SL_TP_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    MAIN market order fills. GateIO 'futures.orders' WS emits fill (SECOND ts, × 1000).
    Manager routes via byEntryOrderId (mainId). handleEntryFilled (sl_tp_deadline_post_funding)
    places SL + TP via REST. monitor.armed.sl_tp_deadline_post_funding_event logged.
  preconditions:
    - MAIN order placed, GateIO WS connected
  trigger_sequence:
    - GateIO WS: futures.orders {status: "filled", text: <mainId>, create_time: <s>}
    - adapter × 1000 → handleEntryFilled
  expected_behavior:
    - order.filled logged (mainQty, avgFillPrice, ms timestamps in DB)
    - position.opened logged
    - SL + TP placed via REST
    - monitor armed
  observability_contract:
    - log: 'order.filled' {exchange: "gateio", filledQty: ">0"}
    - log: 'position.opened'
    - log: 'order.placed' {kind: "sl"} and {kind: "tp"}
    - log: 'monitor.armed.sl_tp_deadline_post_funding_event' (debug)
    - db:fills createdAt in valid ms range
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/adapters/privatews/gateio.ts (futures.orders — ts * 1000)
    - src/execution/execution/manager.ts:595 (handleEntryFilled sl_tp_deadline_post_funding)
    - src/execution/execution/manager.ts:784 (monitor arm + pollForSlTpFill)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 2 fill → SL+TP)
  status: ⏳
  natural_occurrence: routine

- id: strategy_6.gateio.ORDER_LIFECYCLE.FUNDING_FEE_TIMEOUT_FALLBACK
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    ws.funding_fee not received before timeoutAt. Timeout fires. MAIN order placed
    via WS adapter (timeout path). Flow continues to fill → monitoring.
  preconditions:
    - pre-funding filled, ws.funding_fee not received before timeoutAt
  trigger_sequence:
    - setTimeout at timeoutAt fires → MAIN order placed via timeout path
  expected_behavior:
    - MAIN order placed via WS adapter
    - strategy6.main_placed_timeout (or similar) logged
    - flow continues to MAIN fill → monitoring
  observability_contract:
    - log: 'strategy6.main_placed_timeout' or similar {exchange: "gateio"}
    - log: 'order.placed' {kind: "main"}
    - db:orders {kind: "main"}
  code_refs:
    - src/execution/execution/manager.ts:2320 (timeout callback → MAIN)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (Timeout fallback)
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_6.gateio.TIMING.FUNDING_FEE_TIMESTAMP_CONVERSION
  category: TIMING
  severity: critical
  description: >
    GateIO account.book funding event timestamp is in SECONDS. The adapter must
    convert to ms (× 1000) before the bus.emit('ws.funding_fee', {fundingTime}).
    The monitor tolerance check (±5000ms) uses ms. If timestamp is in seconds,
    |fundingTime - fundingTs| will be ~1700000 >> 5000 and the event will NEVER match.
  preconditions:
    - GateIO account.book funding event received
  trigger_sequence:
    - GateIO WS: account.book {create_time: <seconds>}
    - adapter: fundingTime = create_time * 1000
    - bus.emit('ws.funding_fee', {fundingTime})
    - monitor.ts:201: |fundingTime - fundingTs| <= 5000ms
  expected_behavior:
    - fundingTime in ms → tolerance check passes
    - ws.funding_fee matched → settle('funding_fee')
    - NOT: event filtered out due to timestamp mismatch (seconds vs ms)
  observability_contract:
    - log: 'monitor.settle' {reason: "funding_fee", source: "ws"} (NOT timeout)
    - latencyMs < 10000 (reasonable value)
  code_refs:
    - src/execution/adapters/privatews/gateio.ts (account.book timestamp conversion)
    - src/execution/execution/monitor.ts:201 (±5000ms tolerance)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    CRITICAL: if GateIO adapter emits fundingTime in seconds instead of ms, the
    ws.funding_fee event will NEVER match and every strategy_6 intent on GateIO
    will fall back to timeout. This is a silent failure (timeout looks normal in logs).

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_6.gateio.OCO.SL_FILLS_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    SL fills for MAIN position. GateIO 'futures.orders' fill for SL (SECOND ts, × 1000).
    Monitor settle('sl'). handleMonitorExit cancels TP (TEXT_DUPLICATED OK).
  preconditions:
    - intent in monitoring, SL and TP resting
  trigger_sequence:
    - GateIO WS: futures.orders {status: "filled", text: <slId>}
    - monitor.settle('sl')
  expected_behavior:
    - monitor.settle {reason: "sl"} logged
    - oco.cancel.start for TP (TEXT_DUPLICATED = success)
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: <tpId>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
  code_refs:
    - src/execution/execution/monitor.ts:124 (ws.order SL listener)
    - src/execution/execution/manager.ts:1502 (cancel tp on sl)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_6.gateio.OCO.DEADLINE_CANCELS_BOTH
  category: OCO
  severity: critical
  description: >
    Deadline fires. SL and TP cancelled (TEXT_DUPLICATED OK). Market close placed.
  preconditions:
    - intent in monitoring at deadlineAt, neither SL nor TP filled
  trigger_sequence:
    - monitor.settle('deadline') → cancel [sl, tp] → market close
  expected_behavior:
    - oco.cancel.start x2 (TEXT_DUPLICATED = success)
    - order.placed {kind: "close", reduceOnly: true}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'oco.cancel.start' x2
    - log: 'order.placed' {kind: "close"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/manager.ts:1578 (cancel refs)
    - src/execution/execution/manager.ts:1660 (market close)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_6.gateio.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_6 intent is in monitoring (MAIN filled, SL/TP
    resting). Recovery rehydrates IntentState. manager.start() re-arms
    sl_tp_deadline_post_funding_event monitor. GateIO symbol normalization applied.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=sl_tp_deadline_post_funding_event
    - exitOrderRefs.sl and .tp present
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor armed (sl_tp_deadline_post_funding_event)
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.sl_tp_deadline_post_funding_event' (debug)
  code_refs:
    - src/execution/recovery/index.ts:302 (GateIO symbol normalization)
    - src/execution/recovery/index.ts:245 (rehydrated states)
    - src/execution/execution/manager.ts:1888 (re-arm)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_6.gateio.SPEC_DIVERGENCE.GATEIO_TIMESTAMP_SECONDS_CRITICAL
  category: SPEC_DIVERGENCE
  severity: critical
  description: >
    GateIO WS events use SECOND timestamps. Strategy_6 has TWO critical timestamp
    conversion points: (1) futures.orders pre_funding and MAIN fills (must be × 1000),
    (2) account.book funding fee fundingTime (must be × 1000 for ±5000ms monitor match).
    A missing conversion at point (2) causes silent fallback to timeout for ALL
    strategy_6 GateIO intents.
  preconditions:
    - GateIO WS adapter processing futures.orders and account.book events
  trigger_sequence:
    - All GateIO WS event timestamps: raw_ts → raw_ts * 1000 (ms)
  expected_behavior:
    - futures.orders fill: db:fills createdAt in valid ms range
    - account.book funding: fundingTime in ms → monitor match succeeds (not timeout)
  observability_contract:
    - log: 'monitor.settle' {reason: "funding_fee", source: "ws"} (not timeout)
    - db:fills createdAt > 1700000000000
  code_refs:
    - src/execution/adapters/privatews/gateio.ts (all timestamp conversions)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    High severity because the funding_fee timestamp conversion failure is SILENT:
    the timeout fallback fires normally at timeoutAt, making it look like the
    ws.funding_fee event was merely delayed, not that it was never matched.

- id: strategy_6.gateio.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PRE_FUNDING
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No pre-funding WS call made.
  preconditions:
    - kill switch mode != 'off', strategy_6 condition met for gateio
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
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional
```
