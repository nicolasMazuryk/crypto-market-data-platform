# Checklist — binance / strategy_6

Exchange: **binance**
Strategy: **strategy_6** (Post-Funding Directional — WS-Gated Entry)
Spec: `docs-strategy/strategies/strategy_6.md`
Code: `src/execution/strategies/strategy_6.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/binance.ts`, `src/execution/adapters/privatews/mapping.ts`

> **Note:** strategy_6 is LIVE-ONLY. No backtest support. The spec explicitly states this strategy cannot be simulated.
> MAIN order is placed via WS adapter (requiresWsOrderAdapter('strategy_6') = true — manager.ts:91).
> PRE_FUNDING order uses the same WS order adapter path (orderClient returns WS adapter for strategy_6).

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_6.binance.ORDER_LIFECYCLE.PRE_FUNDING_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    At T_f - entryOffsetSeconds (default 10s), manager.submit() is called for a
    strategy_6 intent. A tiny market order (preFundingSide = opposite of mainSide,
    qty = computeMinOrderQty) is placed via the WS order adapter. Its purpose is
    to subscribe the symbol to the private WS funding-fee stream. The order is
    registered in byEntryOrderId before placement so racing WS fill events are
    not lost. After placement, intent transitions acked → working.
  preconditions:
    - funding_threshold check passed (signed: 0 means always-on)
    - market.status = trading
    - preFundingQty < mainQty (min lot < main volume)
    - kill switch inactive
    - WS order adapter available for binance
  trigger_sequence:
    - scheduler: evaluator fires at entryAt = nextFundingTimestamp - entryOffsetSeconds * 1000
    - manager.submit() called with strategy_6 TradeIntent
    - beforeCreateOrder durability write for pre_funding kind
    - WS adapter createOrder called with preFundingSide, preFundingVolume
  expected_behavior:
    - intent.created logged (strategy=strategy_6)
    - intent.submitted logged (entryKind=pre_funding_then_main)
    - order.placed emitted (kind=pre_funding, side=sell or buy, orderType=market, reduceOnly=false)
    - strategy6.pre_funding_placed logged with qty
    - status transitions decided → submitted → acked → working
    - fundingFeeUnsub listener registered on bus for ws.funding_fee
    - timeoutHandle set for timeoutAt = fundingTs + fundingFeeTimeoutSeconds * 1000
    - pollForEntryFill started for preFundingId
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_6", exchange: "binance"}
    - log: 'intent.submitted' {entryKind: "pre_funding_then_main"}
    - log: 'order.placed' {kind: "pre_funding", side: "sell"|"buy", orderType: "market", reduceOnly: false}
    - log: 'strategy6.pre_funding_placed' {qty: "<min lot>"}
    - db:orders row {kind: "pre_funding", orderType: "market", status: "pending"}
    - db:orders {kind: "pre_funding", intentId: "<id>", exchange: "binance"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:2098 (pre_funding_then_main branch)
    - src/execution/execution/manager.ts:2111 (preFundingId = ids.forIntent(intent.id, 90))
    - src/execution/execution/manager.ts:2334 (preFunding REST/WS createOrder call)
    - src/execution/execution/manager.ts:2367 (order.placed emit for pre_funding)
    - src/execution/execution/manager.ts:2379 (strategy6.pre_funding_placed log)
    - src/execution/execution/manager.ts:2384 (acked → working transition)
    - src/execution/execution/manager.ts:91 (requiresWsOrderAdapter — strategy_6 uses WS)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 1)
  status: ⏳
  natural_occurrence: routine
  notes: >
    On Binance, the WS order adapter uses the same FAPI private connection. The
    pre-funding order clientOrderId is ids.forIntent(intent.id, 90). Binance
    does not transform clientOrderId. The order is registered in byEntryOrderId
    via canonicalize(binance, preFundingId) before the WS createOrder call so
    concurrent ACCOUNT_UPDATE / ORDER_TRADE_UPDATE events during the call are not lost.

- id: strategy_6.binance.ORDER_LIFECYCLE.PRE_FUNDING_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    The pre-funding tiny market order fills. Binance emits ORDER_TRADE_UPDATE on the
    private WS with status=FILLED and clientOrderId matching the preFundingId (field 'c').
    Manager routes the event via byEntryOrderId lookup, detects isPreFunding=true,
    logs strategy6.pre_funding_filled, stores preFundingFilledQty. Intent state is
    emitted (emitState). Intent remains in working state awaiting ws.funding_fee.
  preconditions:
    - pre-funding order placed (status=working)
    - Binance private WS connected
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {e: "ORDER_TRADE_UPDATE", o: {X: "FILLED", c: <preFundingId>}}
  expected_behavior:
    - order.filled bus event emitted for pre-funding
    - strategy6.pre_funding_filled logged (filledQty = min lot qty)
    - s.preFundingFilledQty set to order.filledQty
    - intent stays in working state (does NOT transition to monitoring)
    - no SL/TP placed yet
  observability_contract:
    - log: 'strategy6.pre_funding_filled' {filledQty: "<min lot qty>", exchange: "binance"}
    - bus: 'order.filled' {kind: "pre_funding", filledQty: ">0"}
    - db:fills row for pre-funding fill
    - db:intentLifecycleEvents NO transition (stays working)
  code_refs:
    - src/execution/execution/manager.ts:1097 (isPreFunding detection)
    - src/execution/execution/manager.ts:1104 (preFundingFilledQty set)
    - src/execution/execution/manager.ts:1108 (status=filled branch)
    - src/execution/execution/manager.ts:1117 (order.filled emit)
    - src/execution/execution/manager.ts:1118 (strategy6.pre_funding_filled log)
    - src/execution/adapters/privatews/mapping.ts:84 (mapOrderTradeUpdate; clientOrderId in field 'c')
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 1 — pre-funding fill detected)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Binance uses 'c' field in ORDER_TRADE_UPDATE for clientOrderId. Market orders
    fill nearly instantly on Binance. The intent stays in working state — this is
    the non-standard state machine: pre-funding fill does not trigger handleEntryFilled.
    The MAIN fill triggers handleEntryFilled.

- id: strategy_6.binance.ORDER_LIFECYCLE.MAIN_PLACED_ON_FUNDING_FEE
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    ws.funding_fee event arrives on the bus (emitted by Binance ACCOUNT_UPDATE m=FUNDING_FEE
    parser). Manager's fundingFeeUnsub listener fires for matching (exchange, symbol,
    fundingTime ± 5s). placeMain() is called: confirmPreFundingFilled() verifies
    preFundingFilledQty > 0, then a MAIN market order (mainSide, mainVolume) is placed
    via the WS order adapter. This is the critical latency-sensitive step.
  preconditions:
    - pre-funding order filled (preFundingFilledQty > 0)
    - ws.funding_fee event received matching (exchange=binance, symbol, fundingTime ± 5s)
    - mainEventLock not yet acquired
    - intent not in TERMINAL state
  trigger_sequence:
    - Binance WS: ACCOUNT_UPDATE {a: {m: "FUNDING_FEE", P: [{s: <symbol>}], B: [...]}, T: <ms>}
    - private-ws-base emits ws.funding_fee on bus
    - fundingFeeUnsub listener fires → placeMain() called
  expected_behavior:
    - confirmPreFundingFilled() returns true (preFundingFilledQty > 0)
    - mainOrderId = ids.forIntent(intent.id, 0) registered in byEntryOrderId
    - MAIN market order placed via WS adapter (low-latency)
    - order.placed logged (kind=entry, side=mainSide, orderType=market, reduceOnly=false)
    - strategy6.main_placed logged
    - pollForEntryFill started for mainOrderId
  observability_contract:
    - log: 'order.placed' {kind: "entry", side: "<mainSide>", orderType: "market", reduceOnly: false}
    - log: 'strategy6.main_placed' {qty: "<mainVolume>"}
    - db:orders row {kind: "entry", orderType: "market", status: "pending"}
  code_refs:
    - src/execution/execution/manager.ts:2200 (placeMain function)
    - src/execution/execution/manager.ts:2209 (confirmPreFundingFilled check)
    - src/execution/execution/manager.ts:2216 (mainOrderId = ids.forIntent(intent.id, 0))
    - src/execution/execution/manager.ts:2241 (WS createOrder for MAIN)
    - src/execution/execution/manager.ts:2270 (order.placed emit for MAIN)
    - src/execution/execution/manager.ts:2283 (strategy6.main_placed log)
    - src/execution/execution/manager.ts:2296 (fundingFeeUnsub listener)
    - src/execution/adapters/privatews/mapping.ts:154 (mapFundingFee — FUNDING_FEE gate)
    - src/execution/adapters/privatews/binance.ts:52 (ACCOUNT_UPDATE → mapFundingFee)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 3)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Binance ACCOUNT_UPDATE with m=FUNDING_FEE: symbol in P[0].s, timestamp in T (ms).
    The mapFundingFee function checks raw.a.m === 'FUNDING_FEE' before emitting.
    The ±5s tolerance window (toleranceMs = 5000) means events arriving up to 5s
    before or after fundingTs are accepted (manager.ts:2299).

- id: strategy_6.binance.ORDER_LIFECYCLE.MAIN_FILLED_SL_TP_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    The MAIN market order fills. Binance emits ORDER_TRADE_UPDATE status=FILLED for
    mainOrderId. Manager calls handleEntryFilled with exitPolicy.kind=sl_tp_deadline_post_funding_event.
    getPositions() is called to confirm actual net position qty (mainVolume - preFundingVolume).
    SL (stop_market) and TP (limit) are placed simultaneously via REST. position.opened
    logged. Monitor armed with sl_tp_deadline (deadlineAt = fundingTs + deadlineSeconds).
  preconditions:
    - MAIN order filled (ORDER_TRADE_UPDATE FILLED for mainOrderId)
    - exitPolicy.kind=sl_tp_deadline_post_funding_event
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {o: {X: "FILLED", c: <mainOrderId>}}
    - handleEntryFilled → sl_tp_deadline_post_funding_event branch
    - rest.getPositions() called to confirm exitQty
    - SL + TP placed via Promise.allSettled
  expected_behavior:
    - s.filledQty = MAIN filled qty; s.avgEntryPrice = MAIN avgFillPrice
    - getPositions() confirms net position (exitQty = pos.qty or fallback)
    - order.placed logged (kind=sl, orderType=stop_market, reduceOnly=true)
    - order.placed logged (kind=tp, orderType=limit, reduceOnly=true)
    - position.opened logged (side=mainSide, filledQty>0)
    - monitor.armed.sl_tp_deadline logged (debug)
    - status transitions working → filled → monitoring
  observability_contract:
    - log: 'order.filled' {filledQty: "<mainVolume>", exchange: "binance"}
    - log: 'order.placed' {kind: "sl", orderType: "stop_market", reduceOnly: true}
    - log: 'order.placed' {kind: "tp", orderType: "limit", reduceOnly: true}
    - log: 'position.opened' {side: "<mainSide>", filledQty: ">0"}
    - log (debug): 'monitor.armed.sl_tp_deadline' {deadlineDelay, slId, tpId}
    - db:intentLifecycleEvents working→filled→monitoring
    - db:orders {kind: "sl", status: "pending"}, {kind: "tp", status: "pending"}
  code_refs:
    - src/execution/execution/manager.ts:595 (sl_tp_deadline_post_funding_event branch)
    - src/execution/execution/manager.ts:607 (exitQty = filledQty - preFundingVolume, then getPositions override)
    - src/execution/execution/manager.ts:609 (rest.getPositions() call)
    - src/execution/execution/manager.ts:669 (Promise.allSettled SL+TP createOrder)
    - src/execution/execution/manager.ts:748 (order.placed SL+TP emit)
    - src/execution/execution/manager.ts:782 (position.opened log)
    - src/execution/execution/manager.ts:784 (transition monitoring, monitor.arm)
    - src/execution/execution/monitor.ts:108 (sl_tp_deadline_post_funding_event arm)
    - src/execution/execution/monitor.ts:149 (monitor.armed.sl_tp_deadline debug log)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 3 — SL+TP after MAIN fill)
  status: ⏳
  natural_occurrence: routine
  notes: >
    exitQty = net position = mainVolume - preFundingVolume. getPositions() REST call
    overrides the tracked qty if position is found. If position not found, falls back
    to tracked fills with 'strategy6.position_not_found' warn log (manager.ts:615).
    SL/TP prices anchored to MAIN avgFillPrice (s.avgEntryPrice): slPct = |fundingRate%| * slMultiplier.

- id: strategy_6.binance.ORDER_LIFECYCLE.PRE_FUNDING_REJECTED
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    The pre-funding market order is rejected by Binance (e.g. insufficient margin,
    bad lot size). The WS adapter returns ack.status='rejected'. Manager clears
    fundingFeeUnsub, clears timeoutHandle, removes preFundingId from byEntryOrderId,
    and calls setError with code=pre_funding_order_rejected. Intent terminates.
  preconditions:
    - WS adapter createOrder returns {status: 'rejected', rejectReason: ...}
  trigger_sequence:
    - orderClient(binance, strategy_6).createOrder() returns rejected ack
  expected_behavior:
    - fundingFeeUnsub() called (listener unregistered)
    - clearTimeout(timeoutHandle) called
    - byEntryOrderId entry for preFundingId removed
    - intent.error logged with code=pre_funding_order_rejected
    - no MAIN order placed
    - status transitions submitted → error
  observability_contract:
    - log: 'intent.error' {code: "pre_funding_order_rejected", exchange: "binance"}
    - db:intentLifecycleEvents submitted→error
    - db:orders row {kind: "pre_funding", status: "rejected"} (if durability write ran)
  code_refs:
    - src/execution/execution/manager.ts:2354 (preFundingAck.status === 'rejected' branch)
    - src/execution/execution/manager.ts:2358 (setError pre_funding_order_rejected)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 1 — error handling)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Unlike REST errors (pre_funding_order_failed), rejection means the order reached
    the exchange but was refused. Binance may reject with code -1111 (bad precision)
    if computeMinOrderQty returns a qty not conforming to stepSize. The durability
    write (beforeCreateOrder) runs before createOrder so the DB may have a pending
    order row even though the order was never accepted.

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_6.binance.TIMING.PRE_FUNDING_PLACED_AT_OFFSET
  category: TIMING
  severity: high
  description: >
    PRE_FUNDING order is placed at T_f - entryOffsetSeconds (default 10s). The
    scheduler fires the evaluator at entryAt = nextFundingTimestamp - 10000ms.
    The elapsed time from entryAt to order.placed (pre_funding) should be within
    a few hundred ms (WS adapter latency + durability write).
  preconditions:
    - scheduler running and synced
    - strategy_6 condition met
  trigger_sequence:
    - scheduler fires evaluate() at entryAt = nextFundingTimestamp - 10000
  expected_behavior:
    - strategy6.pre_funding_placed logged within ≤1500ms of entryAt
    - WS order adapter used (low latency vs REST)
  observability_contract:
    - log: 'strategy6.pre_funding_placed' timestamp ≤ entryAt + 1500ms
    - db:orders {kind: "pre_funding"} createdAt within [entryAt, entryAt + 1500ms]
  code_refs:
    - src/execution/strategies/strategy_6.ts:68 (entryAt = nextFundingTimestamp - entryOffsetSeconds*1000)
    - src/execution/execution/manager.ts:2379 (strategy6.pre_funding_placed log)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (entryOffsetSeconds = 10)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Earlier placement window than strategy_1 (10s vs 5s) to ensure the pre-funding
    order accrues the funding fee. Binance funding settlement is at the top of each
    8-hour mark; exchange clock skew rarely exceeds 200ms.

- id: strategy_6.binance.TIMING.FUNDING_FEE_ARRIVES_WITHIN_TOLERANCE
  category: TIMING
  severity: critical
  description: >
    Binance ACCOUNT_UPDATE m=FUNDING_FEE arrives within ±5s of fundingTs. The
    bus.on('ws.funding_fee') listener in placeMain checks
    event.fundingTime >= fundingTs - 5000 && event.fundingTime <= fundingTs + 5000.
    MAIN is placed immediately on receipt. Typical Binance latency: 0-500ms after T_f.
  preconditions:
    - intent in working state with fundingFeeUnsub active
    - pre-funding order placed and filled
  trigger_sequence:
    - T_f: Binance emits ACCOUNT_UPDATE {a.m: "FUNDING_FEE", T: <fundingTs ms>}
    - ws.funding_fee event on bus with fundingTime ≈ fundingTs
  expected_behavior:
    - fundingTime within [fundingTs - 5000, fundingTs + 5000]
    - placeMain() fires → MAIN order placed immediately
    - Time from ws.funding_fee to order.placed (MAIN) ≤ 500ms (WS adapter)
  observability_contract:
    - log: 'strategy6.main_placed' timestamp ≤ ws.funding_fee receivedAt + 500ms
    - log: 'order.placed' {kind: "entry"} timestamp ≤ fundingTs + 1000ms
  code_refs:
    - src/execution/execution/manager.ts:2296 (fundingFeeUnsub listener)
    - src/execution/execution/manager.ts:2298 (fundingTime tolerance check ±5000ms)
    - src/execution/adapters/privatews/mapping.ts:154 (mapFundingFee: fundingTime = raw.T ms)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (±5s tolerance)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Binance T field in ACCOUNT_UPDATE is in milliseconds. mapFundingFee uses raw.T
    directly as fundingTime (mapping.ts:168). No μs→ms conversion needed on Binance.

- id: strategy_6.binance.TIMING.FUNDING_FEE_TIMEOUT_WITH_FILL
  category: TIMING
  severity: high
  description: >
    ws.funding_fee does not arrive before timeoutAt = fundingTs + fundingFeeTimeoutSeconds * 1000.
    The hard timeout fires. Pre-funding was filled so there is an open position.
    closePreFunding() is called: REST cancelOrder for preFundingId (best effort),
    then REST getPositions() to find actual qty, then REST createOrder (market,
    reduceOnly=true) with up to 3 retry attempts (delays: 250ms, 1000ms, 3000ms).
    Intent settles as error with code=funding_event_timeout.
  preconditions:
    - fundingFeeUnsub listener active (ws.funding_fee not received)
    - preFundingFilledQty > 0 (position exists)
    - clock.now() >= timeoutAt
  trigger_sequence:
    - setTimeout fires at timeoutDelay = timeoutAt - clock.now()
    - closePreFunding() called
  expected_behavior:
    - 'strategy6: funding fee timeout — closing pre-funding' warn logged
    - REST cancelOrder attempted for preFundingId (may fail — OK)
    - getPositions() called to find actualFilled
    - REST createOrder (market, reduceOnly=true, side=entrySide) placed
    - 'strategy6.closePreFunding: no position to close' NOT logged (position exists)
    - intent.error logged with code=funding_event_timeout
  observability_contract:
    - log (warn): 'strategy6: funding fee timeout — closing pre-funding' {intentId}
    - log: 'strategy6.closePreFunding: attempt failed' (if retry needed) {attempt}
    - log: 'intent.error' {code: "funding_event_timeout"} (after closePreFunding resolves)
    - db:intentLifecycleEvents working→error
  code_refs:
    - src/execution/execution/manager.ts:2303 (hard timeout setTimeout)
    - src/execution/execution/manager.ts:2309 (timeout warn log)
    - src/execution/execution/manager.ts:2120 (closePreFunding function)
    - src/execution/execution/manager.ts:2150 (no position to close branch)
    - src/execution/execution/manager.ts:2168 (attempt failed warn log)
    - src/execution/execution/manager.ts:2172 (all retries exhausted error log)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 2 — hard timeout)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    The timeout path closes the pre-funding position using entrySide (which equals
    mainSide = opposite of preFundingSide). On Binance, REST cancel may return -2011
    (unknown order) if the market order already filled — this is caught and ignored.
    fundingFeeTimeoutSeconds is config-driven (typically T_f + 30–60s).

- id: strategy_6.binance.TIMING.FUNDING_FEE_TIMEOUT_NO_FILL
  category: TIMING
  severity: medium
  description: >
    ws.funding_fee does not arrive before timeoutAt. Pre-funding order was never
    filled (preFundingFilledQty = 0 or undefined). closePreFunding() calls
    getPositions() and finds actualFilled = 0. Logs 'strategy6.closePreFunding: no
    position to close' and returns. Intent settles as funding_event_timeout.
  preconditions:
    - fundingFeeUnsub listener active
    - preFundingFilledQty = 0 (pre-funding never filled or cancelled)
  trigger_sequence:
    - setTimeout fires at timeoutAt
    - closePreFunding() → getPositions() returns qty=0
  expected_behavior:
    - 'strategy6.closePreFunding: no position to close' info logged
    - no close order placed
    - intent settles as funding_event_timeout error
  observability_contract:
    - log: 'strategy6.closePreFunding: no position to close' {intentId}
    - log: 'intent.error' {code: "funding_event_timeout"}
  code_refs:
    - src/execution/execution/manager.ts:2150 (no position to close log)
    - src/execution/execution/manager.ts:2309 (timeout warn)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 2)
  status: ⏳
  natural_occurrence: rare
  notes: >
    Occurs if the pre-funding market order is slow to fill (thin market, Binance
    momentary queue delay) AND the WS funding_fee event also never arrives. Very
    unlikely on Binance mainnet for liquid symbols.

- id: strategy_6.binance.TIMING.DEADLINE_FIRES_AT_55MIN
  category: TIMING
  severity: critical
  description: >
    Intent in monitoring state. No SL or TP fires. deadlineAt = fundingTs + deadlineSeconds
    (default 3300s = 55min). Monitor timer fires. handleMonitorExit called with reason=deadline.
    Existing SL and TP are cancelled. A market close (kind=close, reduceOnly=true) is placed.
  preconditions:
    - intent in monitoring (SL+TP armed)
    - deadlineAt reached with no SL/TP fill
  trigger_sequence:
    - monitor: deadlineHandle fires → settle('deadline', ...) → handleMonitorExit
  expected_behavior:
    - monitor.deadline_fired logged (info)
    - intent.exiting.start logged (reason=deadline)
    - cancelSiblingExit called for SL and TP refs
    - order.placed logged (kind=close, side=exitSide, orderType=market, reduceOnly=true)
    - status transitions monitoring → exiting → exited
  observability_contract:
    - log: 'monitor.deadline_fired' {intentId, deadlineAt}
    - log: 'intent.exiting.start' {reason: "deadline"}
    - log: 'order.placed' {kind: "close", orderType: "market", reduceOnly: true}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:112 (deadlineHandle setTimeout)
    - src/execution/execution/monitor.ts:114 (monitor.deadline_fired log)
    - src/execution/execution/manager.ts:1479 (intent.exiting.start)
    - src/execution/execution/manager.ts:1578 (cancel SL/TP refs)
    - src/execution/execution/manager.ts:1585 (closeKind = close for deadline)
    - src/execution/execution/manager.ts:1610 (close order via WS adapter)
    - src/execution/execution/manager.ts:1620 (WS rejected → REST fallback)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (deadlineSeconds = 3300)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    strategy_6 uses WS adapter for close order (requiresWsOrderAdapter=true).
    If WS adapter rejects the close (close.ws_rejected logged), manager falls back
    to REST reduce-only market close (manager.ts:1625). Binance supports reduceOnly
    on market orders for futures.

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_6.binance.OCO.SL_FIRES
  category: OCO
  severity: critical
  description: >
    The SL stop_market order triggers and fills. Binance emits ORDER_TRADE_UPDATE
    (status=FILLED, clientOrderId=slId). Monitor detects via ws.order listener
    (slId match). settle('sl') called. handleMonitorExit cancels the residual TP,
    sweeps reduce-only orders, logs intent.exited.complete.
  preconditions:
    - intent in monitoring with SL and TP both active
    - market price reaches SL trigger level
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {X: "FILLED", c: <slId>}
    - monitor.ws.order listener: clientOrderId === slId → settle('sl')
  expected_behavior:
    - intent.exiting.start logged (reason=sl)
    - residual TP cancelled (cancelSiblingExit)
    - oco.sweep.complete logged (foundCount=0 or 1)
    - intent.exited.complete logged (exitReason=sl)
    - status transitions monitoring → exiting → exited
  observability_contract:
    - log: 'intent.exiting.start' {reason: "sl"}
    - log: 'intent.exited.complete' {exitReason: "sl"}
    - db:intentLifecycleEvents monitoring→exiting→exited
    - db:orders {kind: "sl", status: "filled"}, {kind: "tp", status: "cancelled"}
  code_refs:
    - src/execution/execution/monitor.ts:123 (ws.order listener)
    - src/execution/execution/monitor.ts:127 (slId match → settle sl)
    - src/execution/execution/manager.ts:1502 (sl/tp branch in handleMonitorExit)
    - src/execution/execution/manager.ts:1520 (cancelSiblingExit for TP)
    - src/execution/execution/manager.ts:1563 (emitIntentExited)
    - src/execution/execution/manager.ts:1565 (intent.exited.complete log)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (OCO exit)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    On Binance, the SL is placed as STOP_MARKET. The fill event arrives as
    ORDER_TRADE_UPDATE with type=STOP_MARKET, status=FILLED. The clientOrderId
    in field 'c' matches slId. No transformation on Binance.

- id: strategy_6.binance.OCO.TP_FILLS
  category: OCO
  severity: critical
  description: >
    The TP limit order fills. Binance emits ORDER_TRADE_UPDATE (status=FILLED, c=tpId).
    Monitor detects via ws.order listener (tpId match). settle('tp') called.
    handleMonitorExit cancels residual SL. Intent exits reason=tp.
  preconditions:
    - intent in monitoring with SL and TP active
    - market price reaches TP level
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {X: "FILLED", c: <tpId>}
    - monitor.ws.order listener: clientOrderId === tpId → settle('tp')
  expected_behavior:
    - intent.exiting.start logged (reason=tp)
    - residual SL cancelled
    - intent.exited.complete logged (exitReason=tp)
  observability_contract:
    - log: 'intent.exiting.start' {reason: "tp"}
    - log: 'intent.exited.complete' {exitReason: "tp"}
    - db:orders {kind: "tp", status: "filled"}, {kind: "sl", status: "cancelled"}
  code_refs:
    - src/execution/execution/monitor.ts:136 (tpId match → settle tp)
    - src/execution/execution/manager.ts:1502 (sl/tp branch)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (OCO exit)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    TP is a limit order (not TAKE_PROFIT_MARKET) per sl_tp_deadline_post_funding_event
    branch (manager.ts:687). Binance fills limit orders at or better than the limit price.

- id: strategy_6.binance.OCO.SL_TP_PLACEMENT_FAILED
  category: OCO
  severity: high
  description: >
    After MAIN fill, one or both of SL/TP REST createOrder calls fail (rejected or
    error). Manager logs 'manager: post-funding protective order placement failed'.
    closeAfterProtectionFailure is called to immediately market-close the position.
  preconditions:
    - MAIN order filled
    - SL or TP createOrder returns rejected or throws
  trigger_sequence:
    - Promise.allSettled([slResult, tpResult]) → one or both rejected
    - slReject || tpReject → logger.error + closeAfterProtectionFailure
  expected_behavior:
    - 'manager: post-funding protective order placement failed' error logged
    - closeAfterProtectionFailure called → market close placed
    - intent exits with reason=post_funding_protective_order_failed
  observability_contract:
    - log (error): 'manager: post-funding protective order placement failed' {slReject, tpReject}
    - db:intentLifecycleEvents monitoring→exiting→exited (or →error)
  code_refs:
    - src/execution/execution/manager.ts:710 (error log)
    - src/execution/execution/manager.ts:711 (closeAfterProtectionFailure call)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (SL+TP placement)
  status: ⏳
  natural_occurrence: rare
  notes: >
    Binance rejects stop orders with -1111 (precision) or -2019 (reduceOnly). If only
    one of SL/TP fails, the accepted order's ref is passed to closeAfterProtectionFailure
    so it can be swept.

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_6.binance.WEBSOCKET.MAIN_FILL_VIA_WS
  category: WEBSOCKET
  severity: critical
  description: >
    MAIN market order fill arrives via WS ORDER_TRADE_UPDATE (status=FILLED, c=mainOrderId).
    Manager routes via byEntryOrderId lookup (canonicalize(binance, mainOrderId)).
    isPreFunding check is false (mainOrderId != preFundingOrderId). handleEntryFilled
    is called → SL+TP placed → position.opened → monitoring.
  preconditions:
    - MAIN order placed (status=working)
    - Binance private WS connected
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {e: "ORDER_TRADE_UPDATE", o: {X: "FILLED", c: <mainOrderId>}}
  expected_behavior:
    - handleEntryFilled called with s (exitPolicy=sl_tp_deadline_post_funding_event)
    - SL+TP placed, position.opened logged, monitoring armed
    - intent transitions to monitoring
  observability_contract:
    - log: 'order.filled' {filledQty: "<mainVolume>"}
    - log: 'position.opened' {side: "<mainSide>"}
    - log: 'order.placed' {kind: "sl"}, log: 'order.placed' {kind: "tp"}
    - log (debug): 'monitor.armed.sl_tp_deadline'
  code_refs:
    - src/execution/adapters/privatews/mapping.ts:84 (mapOrderTradeUpdate; 'c' = clientOrderId)
    - src/execution/execution/manager.ts:1129 (main fill branch — not isPreFunding)
    - src/execution/execution/manager.ts:1136 (order.status === filled → handleEntryFilled)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (MAIN fill detection)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Binance MAIN fill arrives typically within 100ms of WS createOrder ACK for market
    orders. The poll fallback (pollForEntryFill) is also started as a safety net.
    If both WS and poll detect fill, second detection is idempotent (TERMINAL guard).

- id: strategy_6.binance.WEBSOCKET.RECONNECT_BETWEEN_PREFUNDING_AND_FUNDING_FEE
  category: WEBSOCKET
  severity: high
  description: >
    WS disconnects after pre-funding fills but before ws.funding_fee arrives.
    On reconnect, store.reconcile() is called (REST getOpenOrders + getPositions).
    The fundingFeeUnsub listener was registered on the bus (not the WS), so it
    survives reconnect. If ws.funding_fee arrives after reconnect within the timeout
    window, MAIN is placed normally. If it does not, the timeout fires closePreFunding.
  preconditions:
    - pre-funding filled, intent in working state
    - WS disconnects then reconnects between T_f-10s and T_f
  trigger_sequence:
    - ws.connection event: disconnected → reconnecting → connected
    - store.reconcile() called
    - ws.funding_fee may or may not arrive after reconnect
  expected_behavior:
    - store.reconcile() called → log: 'store.reconcile.complete' {durationMs, desyncCount}
    - fundingFeeUnsub listener still active on bus (survives reconnect)
    - if ws.funding_fee arrives after reconnect → MAIN placed normally
    - if timeout fires first → closePreFunding() called
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal bus — no logger.info)
    - log: event='ws.connection' {exchange: "binance", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - log: 'strategy6.main_placed' (if funding_fee arrives post-reconnect)
    - log (warn): 'strategy6: funding fee timeout — closing pre-funding' (if timeout)
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (reconcile on reconnect)
    - src/execution/execution/manager.ts:2296 (bus.on ws.funding_fee — bus-level, not WS-level)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 2 — WS dependency)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    The fundingFeeUnsub listener is registered on the internal EventBus (not the raw WS
    client), so reconnects of the underlying WS client do not affect the listener.
    However, if the WS drops and reconnects AFTER T_f and the ACCOUNT_UPDATE was missed
    entirely, the timeout will fire. Binance listen key expires after 60min; heartbeat
    keepalive runs every 30min to prevent this.

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_6.binance.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while a strategy_6 intent is in status=monitoring (MAIN filled,
    SL+TP active, deadline pending). Recovery rehydrates the intent from DB, restores
    exitOrderRefs (sl, tp), re-arms monitor with sl_tp_deadline_post_funding_event policy.
    Deadline timer re-fires at deadlineAt (may be immediate if past).
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=sl_tp_deadline_post_funding_event
    - exitOrderRefs.sl and exitOrderRefs.tp set
  trigger_sequence:
    - process restart → runRecovery() → loadActiveIntents() → manager.start()
    - monitor.arm(s) called for all monitoring intents
  expected_behavior:
    - recovery: rehydrated intent states logged (rehydratedCount ≥ 1)
    - monitor.armed.sl_tp_deadline logged (debug) with deadlineDelay ≥ 0
    - SL/TP WS listener re-registered (monitor.ts:123)
    - pollForSlTpFill restarted
    - exit fires normally (SL/TP hit or deadline)
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: "≥1"}
    - log (debug): 'monitor.armed.sl_tp_deadline' {deadlineDelay, slId, tpId}
    - subsequent exit logs (intent.exiting.start, intent.exited.complete)
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated intent states log)
    - src/execution/execution/manager.ts:1888 (start — re-arm monitoring intents)
    - src/execution/execution/monitor.ts:108 (sl_tp_deadline_post_funding_event arm)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (no recovery in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Recovery re-arms the monitor with the stored exitOrderRefs. The fundingFeeUnsub
    listener is NOT re-registered (MAIN already filled; ws.funding_fee no longer
    relevant). The pre-funding position is already netted out in the MAIN fill.

- id: strategy_6.binance.RECOVERY.RESTART_BEFORE_MAIN_ENTRY
  category: RECOVERY
  severity: high
  description: >
    Process restarts while intent is in working state (pre-funding filled or placed,
    MAIN not yet placed, ws.funding_fee not yet received). Recovery rehydrates the
    intent in working state. The fundingFeeUnsub listener is NOT re-registered
    (submit() is not re-called). The pre-funding order may be orphaned (open on
    Binance). Recovery orphan sweep may cancel it. Intent is stuck in working state
    with no exit path unless recovery transitions it to error.
  preconditions:
    - intent in DB with status=working
    - entryPolicy.kind=pre_funding_then_main
    - MAIN order not yet placed
  trigger_sequence:
    - process restart before ws.funding_fee received
    - runRecovery() rehydrates working intent
  expected_behavior:
    - recovery: rehydrated intent states logged
    - fundingFeeUnsub NOT re-registered (complex: requires re-running submit flow)
    - orphan pre-funding order may be cancelled by recovery orphan sweep
    - intent may remain stuck in working state
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: "≥1"}
    - log: 'recovery: orphan order found, cancelling' (if pre-funding order open)
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated intent states)
    - src/execution/recovery/index.ts:271 (orphan cancel loop)
    - src/execution/execution/manager.ts:1888 (start — only monitoring re-armed, not working)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (no recovery in spec)
  status: ⏳
  natural_occurrence: rare
  notes: >
    This is a known gap: working-state strategy_6 intents are not recoverable to
    the MAIN-placement phase after restart. The pre-funding position may remain open
    until the orphan sweep or manual intervention. This is more complex than strategy_1
    recovery because the submit() WS listener registration is non-trivial to replay.

# ── STRATEGY_SPECIFIC ────────────────────────────────────────────────────────

- id: strategy_6.binance.STRATEGY_SPECIFIC.NET_POSITION_COMPUTED
  category: STRATEGY_SPECIFIC
  severity: high
  description: >
    After MAIN fills, exitQty = net position = filledQty (MAIN) - preFundingVolume.
    getPositions() REST call overrides this with actual exchange position qty.
    SL+TP are placed for the net qty. The pre-funding position (opposite side)
    is already netted out by the exchange before getPositions() is called.
  preconditions:
    - MAIN filled, preFundingFilledQty > 0
    - getPositions() returns pos.qty > 0
  trigger_sequence:
    - handleEntryFilled → sl_tp_deadline_post_funding_event branch
    - exitQty = max(0, s.filledQty - preFundingVolume)
    - rest.getPositions() → pos.qty overrides exitQty
  expected_behavior:
    - exitQty = mainVolume - preFundingVolume (fallback)
    - getPositions() may override to exchange-confirmed qty
    - SL qty = TP qty = confirmed net position
  observability_contract:
    - log (warn): 'strategy6: confirmed position not found, falling back to tracked fills'
      (only if position not found at exchange)
    - log: 'order.placed' {kind: "sl", qty: "<net qty>"}
    - log: 'order.placed' {kind: "tp", qty: "<net qty>"}
  code_refs:
    - src/execution/execution/manager.ts:604 (preFundingVolume from state or policy)
    - src/execution/execution/manager.ts:607 (exitQty = max(0, filledQty - preFundingVolume))
    - src/execution/execution/manager.ts:609 (getPositions REST override)
    - src/execution/execution/manager.ts:614 (strategy6.position_not_found warn — actual log key)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (net position = mainVolume - preFundingVolume)
  status: ⏳
  natural_occurrence: routine
  notes: >
    The log key in the code is 'strategy6.position_not_found' (event field) but the
    message text is 'strategy6: confirmed position not found, falling back to tracked fills'
    (manager.ts:615). On Binance, the netting of opposing positions typically happens
    in hedge mode vs one-way mode — ensure account is in one-way mode (default for most
    FAPI accounts) so the positions cancel cleanly.

- id: strategy_6.binance.STRATEGY_SPECIFIC.PRE_FUNDING_ACCRUES_OPPOSITE_FUNDING
  category: STRATEGY_SPECIFIC
  severity: medium
  description: >
    The pre-funding order is in OPPOSITE direction to mainSide. At T_f, the pre-funding
    position accrues a funding fee in the wrong direction (debit if mainSide=long and
    fundingRate > 0, since preFundingSide=short accrues negative funding). The spec
    notes FUNDING_PRE is always negative (cost). The net funding gain comes from the
    MAIN position which accrues at T_f+ε (after the ws.funding_fee event triggers MAIN).
    The pre-funding funding fee appears as a negative amount in db:fundingAttributions.
  preconditions:
    - pre-funding position open at T_f
    - fundingRate != 0
  trigger_sequence:
    - Binance ACCOUNT_UPDATE m=FUNDING_FEE fires for preFunding position at T_f
  expected_behavior:
    - ws.funding_fee event with fundingAmount < 0 for preFunding symbol (debit)
    - db:fundingAttributions row with negative amount for pre-funding position
    - MAIN placed after this event → MAIN does NOT accrue at this T_f (next period)
  observability_contract:
    - db:fundingAttributions row {intentId: ..., amount: "<negative>"}
  code_refs:
    - src/execution/strategies/strategy_6.ts:49 (preFundingSide = opposite of mainSide)
    - src/execution/adapters/privatews/mapping.ts:154 (mapFundingFee: bc field = balance change)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (FUNDING_PRE always negative)
  status: ⏳
  natural_occurrence: routine
  notes: >
    This is by design: the pre-funding position accrues a small negative funding fee
    (cost of subscription to the WS stream). The MAIN position's funding gain at the
    NEXT funding period should exceed this cost. On Binance, fundingAmount = firstBal.bc
    (balance change, signed).

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_6.binance.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active when strategy_6 intent would otherwise be submitted. Preflight
    rejects with code=kill_switch before any order reaches the exchange. The spec
    has no mention of a kill switch.
  preconditions:
    - kill switch mode != 'off'
    - strategy_6 condition met (threshold, market status, lot check)
  trigger_sequence:
    - manager.submit() → preflight → killSwitch.canPlaceOrder() returns false
  expected_behavior:
    - intent.created logged (decided)
    - intent.error logged with code=kill_switch
    - no order.placed (neither pre_funding nor entry)
  observability_contract:
    - log: 'intent.error' {code: "kill_switch"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:intentLifecycleEvents decided→error
  code_refs:
    - src/execution/execution/preflight.ts:32 (kill switch check)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (no kill switch mentioned)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    The kill switch is the emergency stop for all strategies. Activating it before
    the next funding event prevents both pre-funding and MAIN orders from being placed.
    If activated while an intent is already in working state, it does not cancel
    the pre-funding position — manual intervention required.
```
