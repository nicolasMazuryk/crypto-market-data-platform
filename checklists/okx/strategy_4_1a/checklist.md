# Checklist — okx / strategy_4_1a

Exchange: **okx**
Strategy: **strategy_4_1a** (Negative Funding Ladder LONG — Post-Funding Entry)
Spec: `docs-strategy/strategies/strategy_4_1.md`
Code: `src/execution/strategies/strategy_4_1a.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_4_1a.okx.ORDER_LIFECYCLE.ALL_RUNGS_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - entryOffsetSeconds (default 5s). Preflight passes.
    All N ladder rungs placed in parallel via Promise.allSettled. Each rung gets a
    unique clientOrderId = ids.forIntent(intent.id, i), then dash-stripped by
    canonicalize() for OKX before registration in byEntryOrderId and before the REST
    createOrder call. Each successful rung emits order.placed and logs ladder.rung_placed.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent (default -0.6%)
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - market status = trading
    - N = ladderCount rungs configured
  trigger_sequence:
    - scheduler: evaluator fires at entryAt = nextFundingTimestamp - entryOffsetSeconds * 1000
    - manager.submit() → ladder_limit branch → Promise.allSettled places all N rungs
  expected_behavior:
    - intent.created logged (strategy=strategy_4_1a, exchange=okx)
    - status transitions decided → submitted → acked → working
    - N × order.placed logged (kind=entry, orderType=limit, side=buy, reduceOnly=false)
    - N × ladder.rung_placed logged (info, rungIdx 0..N-1, limitPrice, rungQty)
    - N dash-stripped clientOrderIds registered in byEntryOrderId
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_4_1a", exchange: "okx"}
    - log: 'ladder.rung_placed' {rungIdx: 0..N-1, limitPrice: "<price below market>"}  # N times
    - log: 'order.placed' {kind: "entry", side: "buy", orderType: "limit"}  # N times
    - db:orders N rows {kind: "entry", orderType: "limit", status: "pending"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:130 (canonicalize — strips dashes for OKX)
    - src/execution/execution/manager.ts:2395 (ladder_limit branch start)
    - src/execution/execution/manager.ts:2450 (Promise.allSettled — place all rungs)
    - src/execution/execution/manager.ts:2476 (order.placed emit per rung)
    - src/execution/execution/manager.ts:2489 (ladder.rung_placed info log)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (Entry — ladder_limit)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX limit orders use 'orders' WS channel for fill events. OKX clientOrderId max
    32 chars, alphanumeric. UUID with dashes stripped = 32 chars exactly. Each rung
    gets a distinct ID (ids.forIntent(id, i)) — all stripped before use.

- id: strategy_4_1a.okx.ORDER_LIFECYCLE.RUNG_REJECTED_BY_EXCHANGE
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    One or more rungs are rejected by OKX (e.g. price filter, min qty, or rate limit
    code 50011). REST createOrder ACK returns status=rejected. Manager logs
    'ladder rung rejected' at warn level. Remaining rungs proceed. T_funding timer
    still fires; if any other rungs filled → normal path.
  preconditions:
    - at least one rung's limitPrice or qty violates OKX exchange rules
  trigger_sequence:
    - rest.createOrder for rung i returns {status: "rejected", rejectReason: <reason>}
  expected_behavior:
    - 'ladder rung rejected' warn logged for the rejected rung
    - no order.placed for the rejected rung
    - remaining rungs continue to working state
    - T_funding timer fires and processes any filled rungs
  observability_contract:
    - log: 'ladder rung rejected' {intentId, rungIdx: <i>, reason: "<reason>"}  # warn level
    - db:orders no row for rejected rung
    - log: 'ladder.rung_placed' for non-rejected rungs only
  code_refs:
    - src/execution/execution/manager.ts:2472 (ack.status === 'rejected' check)
    - src/execution/execution/manager.ts:2473 (logger.warn 'ladder rung rejected')
    - src/execution/execution/manager.ts:2494 (byEntryOrderId.delete on catch)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    OKX rejects limit orders outside price bands (e.g. deviation > 20% from mark price).
    OKX rate limit code 50011 causes CCXT RateLimitExceeded which is caught before
    the 'rejected' path — see _cross_cutting.md §3.

- id: strategy_4_1a.okx.ORDER_LIFECYCLE.PRE_FUNDING_FILL_WARNING
  category: ORDER_LIFECYCLE
  severity: medium
  description: >
    A limit rung fills before T_funding (market dips into the ladder early). OKX
    'orders' WS channel emits state=filled with dash-stripped clOrdId. Manager marks
    rung.filled=true, logs 'ladder.pre_funding_fill' at warn, increments metric.
    Position is kept; T_funding timer still resolves.
  preconditions:
    - intent in working status (rungs placed)
    - market price dips below a rung's limitPrice before T_funding
  trigger_sequence:
    - OKX WS: 'orders' {state: "filled", clOrdId: <stripped rung ID>}
    - clock.now() < intent.nextFundingTimestamp when fill processed
  expected_behavior:
    - rung.filled=true, aggregate qty/price updated
    - status transitions working → partially_filled
    - 'ladder.pre_funding_fill' warn logged with clientOrderId
    - T_funding timer still fires and processes any remaining unfilled rungs
  observability_contract:
    - log: 'ladder.pre_funding_fill' {intentId, clientOrderId: "<stripped rung id>"}  # warn
    - db:intentLifecycleEvents transition to partially_filled
    - metrics: intentRejectedTotal{code="ladder_pre_funding_fill"} incremented
  code_refs:
    - src/execution/execution/manager.ts:1047 (ladder_limit branch in handleEntryOrderEvent)
    - src/execution/execution/manager.ts:1074 (transition partially_filled)
    - src/execution/execution/manager.ts:1077 (clock.now() < nextFundingTimestamp check)
    - src/execution/execution/manager.ts:1078 (ladder.pre_funding_fill warn)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (Scenario A invariant)
  status: ⏳
  natural_occurrence: rare

- id: strategy_4_1a.okx.ORDER_LIFECYCLE.T_FUNDING_TIMER_RESOLVES
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    T_funding timer fires. Manager cancels all unfilled rungs (best-effort REST
    cancelOrder for each, dash-stripped IDs used). Computes aggregate filledQty
    and weighted-avg P_avg. Emits order.filled programmatically. Transitions to filled.
    Calls handleEntryFilled → places SL + TP → transitions to monitoring.
  preconditions:
    - intent in working or partially_filled
    - at least one rung has filled (filledQty > 0)
    - T_funding timer fires
  trigger_sequence:
    - setTimeout at delayToFunding = nextFundingTimestamp - now
    - T_funding callback: cancel unfilled rungs, aggregate, emit order.filled
    - handleEntryFilled: place SL (buy stop_market) + TP (buy limit)
  expected_behavior:
    - unfilled rungs cancelled (best-effort)
    - 'ladder.resolved' or 'ladder.t_funding_fire' logged (info)
    - order.filled logged programmatically (filledQty=aggregate, avgFillPrice=P_avg)
    - position.opened logged (side=long, filledQty)
    - SL + TP placed via REST
    - monitor.armed.sl_tp_deadline logged (debug)
  observability_contract:
    - log: 'ladder.rung_cancelled' or similar for each unfilled rung (if any)
    - log: 'order.filled' {filledQty: "sum of filled rungs", avgFillPrice: P_avg}
    - log: 'position.opened' {side: "long"}
    - log: 'order.placed' {kind: "sl"} and {kind: "tp"}
    - log: 'monitor.armed.sl_tp_deadline' (debug)
    - db:intentLifecycleEvents (partially_)filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:2500 (T_funding timer callback)
    - src/execution/execution/manager.ts:2510 (cancel unfilled rungs — best-effort)
    - src/execution/execution/manager.ts:2525 (aggregate filledQty + P_avg)
    - src/execution/execution/manager.ts:2530 (emit order.filled programmatically)
    - src/execution/execution/manager.ts:2538 (transition filled)
    - src/execution/execution/manager.ts:2540 (handleEntryFilled call)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (T_funding timer resolves ladder)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX cancel uses dash-stripped clientOrderId. OKX may return error if the rung
    already filled between T_funding and the cancel call — that's fine (fill takes priority).

- id: strategy_4_1a.okx.ORDER_LIFECYCLE.LADDER_NO_FILLS
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    T_funding timer fires but no rungs have filled (filledQty=0). Manager logs
    'ladder.no_fills' at warn and calls setError with code=ladder_no_fills.
    All unfilled rungs are cancelled (best-effort). Intent transitions to error (terminal).
  preconditions:
    - intent in working status, no rungs filled before T_funding
  trigger_sequence:
    - T_funding timer fires → filledQty === 0
    - setError(s, 'ladder_no_fills')
  expected_behavior:
    - 'ladder.no_fills' warn logged
    - intent.error logged with code=ladder_no_fills
    - all unfilled rungs cancelled
    - intent terminal (no SL/TP placed)
  observability_contract:
    - log: 'ladder.no_fills' {intentId}  # warn level
    - log: 'intent.error' {code: "ladder_no_fills"}
    - db:intentLifecycleEvents working→error
  code_refs:
    - src/execution/execution/manager.ts:2500 (T_funding callback)
    - src/execution/execution/manager.ts:2520 (filledQty === 0 check)
    - src/execution/execution/manager.ts:2521 ('ladder.no_fills' warn)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Occurs if the post-funding price drop is shallower than the deepest rung.
    Common in low-volatility markets.

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_4_1a.okx.TIMING.RUNGS_PLACED_BEFORE_T_FUNDING
  category: TIMING
  severity: high
  description: >
    All N rungs must be placed at T_f - 5s and sit in the OKX order book until
    T_funding fires. The limit prices are below current price, so rungs should NOT
    fill immediately (unless market is unusually volatile). OKX timestamps in ms.
  preconditions:
    - scheduler fires at entryAt
    - market price is above all rung limitPrices at entryAt
  trigger_sequence:
    - evaluate() fires at entryAt = nextFundingTimestamp - entryOffsetSeconds*1000
    - ladder_limit branch: place all rungs
  expected_behavior:
    - order.placed (limit) logged for each rung (no immediate fill)
    - db:orders all rungs {status: "pending"} at entryAt + epsilon
  observability_contract:
    - log: 'ladder.rung_placed' x N at approximately entryAt
    - db:orders N rows {status: "pending"} (not filled) at entryAt
  code_refs:
    - src/execution/execution/manager.ts:2395 (ladder_limit branch)
    - src/execution/strategies/strategy_4_1a.ts:58 (entryAt computation)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_4_1a.okx.TIMING.SL_TP_PLACED_AT_T_FUNDING
  category: TIMING
  severity: critical
  description: >
    SL and TP are placed at T_funding (when T_funding timer fires), not at entry
    time. This means SL/TP are absent from the order book during the [entryAt, T_funding]
    window when rungs are live. If a rung fills in this window (pre-funding fill),
    the position is temporarily unprotected.
  preconditions:
    - at least one rung filled before T_funding
  trigger_sequence:
    - T_funding timer fires → handleEntryFilled → place SL + TP
  expected_behavior:
    - SL and TP placed only after T_funding fires
    - position unprotected between pre-funding fill and T_funding timer
  observability_contract:
    - log: 'order.placed' {kind: "sl"} and {kind: "tp"} timestamps ≥ nextFundingTimestamp
    - no SL/TP before T_funding in logs or db
  code_refs:
    - src/execution/execution/manager.ts:2540 (handleEntryFilled called from T_funding timer)
    - src/execution/execution/manager.ts:406 (handleEntryFilled places SL+TP)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    The pre-funding fill window is a design tradeoff. SL/TP placement is intentionally
    deferred to T_funding to ensure position is at the intended avg price.

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_4_1a.okx.OCO.SL_FILLS_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    SL stop_market (sell) fills after T_funding. OKX 'orders' channel emits state=filled
    for SL. Monitor ws.order listener detects fill (slId matches), calls settle('sl').
    handleMonitorExit cancels TP via cancelSiblingExit. OKX cancel uses stripped slClientOrderId.
  preconditions:
    - intent in monitoring (SL and TP resting)
    - price drops below SL stop price (long position)
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
    - log: 'oco.cancel.start' {clientOrderId: <tpId stripped>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:124 (ws.order listener for SL fill)
    - src/execution/execution/manager.ts:1502 (cancel tp ref on sl exit)
    - src/execution/execution/manager.ts:1520 (cancelSiblingExit)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (SL exit path)
  status: ⏳
  natural_occurrence: occasional

- id: strategy_4_1a.okx.OCO.TP_FILLS_SL_CANCELED
  category: OCO
  severity: critical
  description: >
    TP limit (sell) fills. OKX 'orders' channel emits state=filled for TP.
    Monitor ws.order listener detects fill (tpId matches), calls settle('tp').
    handleMonitorExit cancels SL via cancelSiblingExit.
  preconditions:
    - intent in monitoring (SL and TP resting)
    - price rises to TP limit level (long position, sell TP)
  trigger_sequence:
    - OKX WS: 'orders' {state: "filled", clOrdId: <tpId stripped>}
    - monitor.settle('tp') → handleMonitorExit(s, 'tp')
  expected_behavior:
    - monitor.settle {reason: "tp"} logged
    - intent.exiting.start {reason: "tp"} logged
    - oco.cancel.start for SL ref
    - intent.exited.complete {exitReason: "tp"}
  observability_contract:
    - log: 'monitor.settle' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: <slId stripped>}
    - log: 'intent.exited.complete' {exitReason: "tp"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:131 (ws.order listener for TP fill)
    - src/execution/execution/manager.ts:1504 (cancel sl ref on tp exit)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (TP exit path)
  status: ⏳
  natural_occurrence: occasional

- id: strategy_4_1a.okx.OCO.DEADLINE_CANCELS_BOTH
  category: OCO
  severity: critical
  description: >
    Deadline fires while SL and TP resting. cancelSiblingExit called for each ref.
    Market close (sell, reduceOnly=true) placed for the long position.
  preconditions:
    - intent in monitoring at deadlineAt
    - neither SL nor TP filled
  trigger_sequence:
    - monitor.settle('deadline') → handleMonitorExit: cancel [sl, tp] → market close
  expected_behavior:
    - oco.cancel.start logged for SL and TP
    - order.placed {kind: "close", side: "sell", orderType: "market", reduceOnly: true}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'oco.cancel.start' x2
    - log: 'order.placed' {kind: "close", side: "sell", reduceOnly: true}
    - log: 'intent.exited.complete' {exitReason: "deadline"}
  code_refs:
    - src/execution/execution/manager.ts:1578 (cancel refs loop)
    - src/execution/execution/manager.ts:1660 (order.placed close)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (Deadline exit)
  status: ⏳
  natural_occurrence: routine

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_4_1a.okx.WEBSOCKET.RECONNECT_WHILE_RUNGS_RESTING
  category: WEBSOCKET
  severity: high
  description: >
    OKX private WS disconnects and reconnects while ladder rungs are resting in the
    order book (before T_funding). store.reconcile() called on reconnect — REST
    getOpenOrders fetches all resting rungs. byEntryOrderId map is NOT rebuilt from
    reconcile (it's an in-memory map); WS fill events arriving after reconnect still
    route correctly via existing byEntryOrderId entries (stripped form).
  preconditions:
    - intent in working status, rungs resting in OKX order book
    - OKX WS disconnects and reconnects
  trigger_sequence:
    - ws.connection {state: "disconnected"} then {state: "connected"}
    - store.reconcile('okx') called
  expected_behavior:
    - REST getOpenOrders confirms rungs still live
    - byEntryOrderId map unchanged (in-memory)
    - T_funding timer still fires at original time
    - WS fill events after reconnect routed via existing stripped IDs
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal — no logger.info)
    - log: event='ws.connection' {exchange: "okx", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - resting rungs visible in REST getOpenOrders response
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile call)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    A WS fill event arriving for a rung immediately after reconnect is handled correctly
    because byEntryOrderId was populated before WS disconnected (in-memory, survives reconnect).

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_4_1a.okx.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_4_1a intent is in monitoring (all rungs resolved,
    SL and TP resting). Recovery rehydrates IntentState including exitOrderRefs.
    manager.start() re-arms sl_tp_deadline monitor. OKX canonicalize() applied to
    all clientOrderIds during recovery.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=sl_tp_deadline
    - exitOrderRefs.sl and .tp present in DB
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
    - src/execution/recovery/index.ts:245 (rehydrated intent states log)
    - src/execution/execution/manager.ts:1888 (start — re-arm)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_4_1a.okx.RECOVERY.RESTART_WHILE_RUNGS_RESTING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_4_1a intent is in working status and ladder rungs
    are resting in OKX order book (before T_funding). Recovery rehydrates IntentState.
    T_funding timer is NOT re-armed by recovery (only monitoring/exiting/working re-arm).
    The open resting rungs are seen as orphan orders and CANCELLED by recovery.
    Intent transitions to error (orphan cancellation path).
  preconditions:
    - intent in DB with status=working
    - rungs resting in OKX order book
    - exitPolicy.kind=sl_tp_deadline (entered via ladder_limit)
  trigger_sequence:
    - process restart → runRecovery() → loadActiveIntents (status=working)
    - REST getOpenOrders: resting rungs found
    - recovery: orphan order found → cancelOrder → 'recovery: orphan order found, cancelling' logged
  expected_behavior:
    - 'recovery: orphan order found, cancelling' logged for each resting rung
    - rungs cancelled on OKX
    - intent status: if all rungs cancelled with no fills → intent may be left in error
  observability_contract:
    - log: 'recovery: orphan order found, cancelling' {clientOrderId: "<stripped>"}
    - REST cancelOrder calls visible for each rung
    - intent in error state after recovery if no fills occurred
  code_refs:
    - src/execution/recovery/index.ts:271 (orphan order cancel loop)
    - src/execution/recovery/index.ts:275 ('recovery: orphan order found, cancelling' log)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (no recovery during entry phase in spec)
  status: ⏳
  natural_occurrence: rare
  notes: >
    This is a critical edge case: recovery during the ladder placement window leaves the
    position in an undefined state. The resting rungs are treated as orphans and cancelled.
    Manual intervention may be needed if any rungs filled before the restart (open position
    with no intent tracking it).

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_4_1a.okx.SPEC_DIVERGENCE.OKX_DASH_STRIP_ALL_RUNG_IDS
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    All N rung clientOrderIds are dash-stripped by canonicalize() for OKX. The stripped
    IDs are used in byEntryOrderId registration, REST createOrder, and T_funding timer
    cancelOrder calls. Recovery also applies canonicalize(). This is OKX-specific and
    not in the strategy spec.
  preconditions:
    - strategy_4_1a intent submitted for okx
  trigger_sequence:
    - ladder_limit branch: for each rung i, canonicalize('okx', ids.forIntent(intent.id, i)) → stripped
    - stripped IDs registered in byEntryOrderId
    - OKX fill events carry stripped clOrdId
  expected_behavior:
    - all OKX rung orders use dash-free IDs
    - WS fill events from OKX match byEntryOrderId correctly
    - no 'rung not found in byEntryOrderId' errors
  observability_contract:
    - db:orders clientOrderId column: no dashes for all rung rows (okx only)
    - log: 'ladder.rung_placed' x N with dash-free IDs
  code_refs:
    - src/execution/execution/manager.ts:130 (canonicalize)
    - src/execution/recovery/index.ts:132 (canonicalize in recovery)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (no mention of OKX ID constraints)
  status: ⏳
  natural_occurrence: routine

- id: strategy_4_1a.okx.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active at submit time. Preflight rejects with code=kill_switch.
    No OKX REST calls made (no rungs placed).
  preconditions:
    - kill switch mode != 'off'
    - strategy_4_1a condition met for okx
  trigger_sequence:
    - manager.submit() → preflight → killSwitch.canPlaceOrder() returns false
  expected_behavior:
    - intent.error logged with code=kill_switch
    - no rungs placed, no order.placed
  observability_contract:
    - log: 'intent.error' {code: "kill_switch"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:intentLifecycleEvents decided→error
    - db:orders no rows for this intentId
  code_refs:
    - src/execution/execution/preflight.ts:32 (kill switch check)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md
  status: ⏳
  natural_occurrence: occasional
```
