# Checklist — okx / strategy_2

Exchange: **okx**
Strategy: **strategy_2** (Negative Funding LONG — Retracement Exit)
Spec: `docs-strategy/strategies/strategy_2.md`
Code: `src/execution/strategies/strategy_2.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/okx.ts`

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_2.okx.ORDER_LIFECYCLE.ENTRY_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - entryOffsetSeconds (default 5s). Preflight passes.
    setLeverage succeeds. A market BUY is placed via the WS order adapter
    (requiresWsOrderAdapter('strategy_2')=true). canonicalize() strips dashes from
    the clientOrderId for OKX before registration in byEntryOrderId.
    order.placed logged with kind=entry, side=buy, orderType=market, reduceOnly=false.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - market status = trading
  trigger_sequence:
    - scheduler: evaluator fires at entryAt = nextFundingTimestamp - entryOffsetSeconds * 1000
    - manager.submit() called with strategy_2 TradeIntent (exchange=okx)
  expected_behavior:
    - intent.created logged (strategy=strategy_2, exchange=okx)
    - intent.submitted logged (entryKind=market)
    - clientOrderId dash-stripped by canonicalize() before byEntryOrderId registration
    - order.placed logged (kind=entry, side=buy, orderType=market, reduceOnly=false)
    - status transitions decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_2", exchange: "okx"}
    - log: 'intent.submitted' {entryKind: "market"}
    - log: 'order.placed' {kind: "entry", side: "buy", orderType: "market", reduceOnly: false}
    - db:orders row {kind: "entry", orderType: "market", status: "pending"}
    - db:intentLifecycleEvents transitions decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:130 (canonicalize — strips dashes for OKX)
    - src/execution/execution/manager.ts:2081 (transition submitted)
    - src/execution/execution/manager.ts:2755 (order.placed log)
    - src/execution/strategies/strategy_2.ts:59 (entryAt = nextFundingTimestamp - entryOffsetSeconds*1000)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (Entry — market BUY via WS adapter at T_f - 5s)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX clientOrderId max 32 chars, alphanumeric. UUID with dashes stripped = 32 chars.
    OKX WS adapter sends stripped clOrdId in createOrder request.

- id: strategy_2.okx.ORDER_LIFECYCLE.ENTRY_FILLED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Entry market order fills. OKX private WS emits on 'orders' channel with
    state=filled and clOrdId matching the dash-stripped clientOrderId. Manager routes
    via byEntryOrderId lookup, logs order.filled, transitions to filled, then
    handleEntryFilled places SL immediately (stop_market) and arms the retracement monitor.
  preconditions:
    - entry order placed (status=working)
    - OKX private WS connected
  trigger_sequence:
    - OKX WS: 'orders' channel {state: "filled", clOrdId: <stripped-clientOrderId>}
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice present)
    - status transitions working → filled → monitoring
    - SL placed immediately (stop_market, side=sell, reduceOnly=true)
    - position.opened logged (side=long, filledQty > 0)
    - monitor.armed.sl_tp_deadline_retracement logged (debug)
    - spawnRetracementTracker invoked
  observability_contract:
    - log: 'order.filled' {exchange: "okx", filledQty: ">0"}
    - log: 'order.placed' {kind: "sl", side: "sell", orderType: "stop_market", stopPrice: ">0"}
    - log: 'position.opened' {side: "long", filledQty: ">0"}
    - log: 'monitor.armed.sl_tp_deadline_retracement' {deadlineDelay, slId}  # debug
    - db:orders rows for kind=entry (filled) and kind=sl (pending)
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:130 (canonicalize — dash-strip for byEntryOrderId lookup)
    - src/execution/execution/manager.ts:1136 (handleEntryOrderEvent fill branch)
    - src/execution/execution/manager.ts:1156 (order.filled log)
    - src/execution/execution/manager.ts:292 (handleEntryFilled retracement variant)
    - src/execution/execution/manager.ts:368 (order.placed sl log)
    - src/execution/execution/manager.ts:397 (position.opened log)
    - src/execution/execution/manager.ts:400 (monitor.arm call)
    - src/execution/execution/manager.ts:402 (spawnRetracementTracker call)
    - src/execution/execution/monitor.ts:181 (monitor.armed.sl_tp_deadline_retracement debug log)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (SL placed immediately after fill)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX SL order type is 'stop_market' (conditional order). OKX requires algoOrd channel
    for conditional orders — verify adapter handles algoOrd fills for SL.
    OKX avgFillPrice comes from 'avgPx' field in orders channel event.

- id: strategy_2.okx.ORDER_LIFECYCLE.SL_PLACED_IMMEDIATELY
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Immediately after entry fill, handleEntryFilled places a stop_market SL order via REST.
    For OKX, SL may be an 'algo' order (OKX's conditional order type). If SL placement
    fails or is rejected, closeAfterProtectionFailure fires instead of monitoring.
  preconditions:
    - entry filled, avgEntryPrice known
  trigger_sequence:
    - handleEntryFilled called after FILLED event
    - rest.createOrder {type: stop_market, stopPrice: entry * (1 - slPct/100), reduceOnly: true}
  expected_behavior:
    - order.placed logged {kind: "sl", side: "sell", orderType: "stop_market", stopPrice}
    - s.exitOrderRefs.sl set to {clientOrderId, exchangeOrderId}
    - position.opened logged immediately after
  observability_contract:
    - log: 'order.placed' {kind: "sl", orderType: "stop_market", stopPrice: ">0", reduceOnly: true}
    - db:orders row {kind: "sl", orderType: "stop_market", status: "pending"}
    - log: 'position.opened' appears after order.placed(sl)
  code_refs:
    - src/execution/execution/manager.ts:305 (slId = ids.forExit)
    - src/execution/execution/manager.ts:334 (rest.createOrder stop_market)
    - src/execution/execution/manager.ts:368 (order.placed sl log)
    - src/execution/execution/manager.ts:329 (durability write warn on failure)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (SL at avgEntryPrice * (1 - slPct/100))
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX conditional orders (algo SL) fill on the 'orders' channel as well when triggered.
    Verify OKX SL clientOrderId is also dash-stripped via canonicalize() for byCloseOrderId lookup.

- id: strategy_2.okx.ORDER_LIFECYCLE.SL_REJECTED_PROTECTIVE_CLOSE
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    After entry fill, rest.createOrder for the SL returns rejected (OKX error codes
    such as position size mismatch or invalid parameters). closeAfterProtectionFailure
    fires with code=retracement_sl_rejected. Protective market close placed immediately.
  preconditions:
    - entry filled, SL placement returns status=rejected
  trigger_sequence:
    - handleEntryFilled: slResult.status === 'rejected'
    - closeAfterProtectionFailure(s, 'retracement_sl_rejected', ...)
  expected_behavior:
    - protective.close_placed logged (error level) with code=retracement_sl_rejected
    - order.placed logged {kind: "close", reduceOnly: true}
    - intent.error logged with code=retracement_sl_rejected
    - no position.opened, no monitor.arm
  observability_contract:
    - log: 'protective.close_placed' {code: "retracement_sl_rejected"}  # error level
    - log: 'order.placed' {kind: "close", reduceOnly: true}
    - log: 'intent.error' {code: "retracement_sl_rejected"}
    - db:intentLifecycleEvents filled→error
  code_refs:
    - src/execution/execution/manager.ts:345 (slResult.status === 'rejected')
    - src/execution/execution/manager.ts:346 (closeAfterProtectionFailure call)
    - src/execution/execution/manager.ts:273 (protective.close_placed log)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (no SL rejection path in spec)
  status: ⏳
  natural_occurrence: rare
  notes: >
    OKX SL rejection may include error code 51010 (position not found) or 51131
    (reduce-only not allowed when no position). If position is zero, protective
    close also fails — check for 'protective market close rejected' log.

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_2.okx.TIMING.ENTRY_AT_CORRECT_OFFSET
  category: TIMING
  severity: high
  description: >
    Entry order is placed at approximately T_f - entryOffsetSeconds (5s by default).
    WS adapter adds negligible latency. OKX timestamps in events are ms.
  preconditions:
    - scheduler running, strategy condition met
  trigger_sequence:
    - scheduler fires evaluate() at entryAt = nextFundingTimestamp - entryOffsetSeconds*1000
  expected_behavior:
    - intent.submitted timestamp <= entryAt + 1000ms
    - order.placed timestamp <= entryAt + 2000ms
  observability_contract:
    - log: 'intent.submitted' timestamp <= entryAt + 1000ms
    - log: 'order.placed' {kind: "entry"} timestamp <= entryAt + 2000ms
  code_refs:
    - src/execution/strategies/strategy_2.ts:59 (entryAt computation)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (Entry at T_f - 5s)
  status: ⏳
  natural_occurrence: routine

- id: strategy_2.okx.TIMING.FUNDING_FEE_EVENT_OPENS_GATE
  category: TIMING
  severity: critical
  description: >
    At T_f, OKX emits account.bills event with bizType containing "FUND". The OKX
    WS adapter maps this to ws.funding_fee on the bus. The retracement tracker's
    bus.on('ws.funding_fee') handler checks exchange/symbol/fundingTime within 5s
    tolerance of fundingTs, sets fundingGateOpen=true, and begins P_low tracking.
  preconditions:
    - intent in status=monitoring, retracement tracker running
    - OKX WS connected, funding settlement at T_f
  trigger_sequence:
    - OKX WS: account.bills {bizType: "Funding fee", instId: <symbol>}
    - bus.emit('ws.funding_fee') from OKX adapter
  expected_behavior:
    - fundingGateOpen set to true in tracker
    - P_low tracking begins on next 1s tick
    - db:fundingAttributions row inserted
  observability_contract:
    - bus: 'ws.funding_fee' {exchange: "okx", symbol: <normalized symbol>}
    - log: event='intent.funding_gate_opened' {intentId: "<id>", openedAt: ">0", fundingTs: ">0"}
    - db:fundingAttributions row inserted for the funding credit
    - log: 'retracement.tp_placed' appears after gate opens (once P_low makes new low)
  code_refs:
    - src/execution/adapters/privatews/okx.ts (account.bills handler)
    - src/execution/execution/manager.ts:871 (bus.on ws.funding_fee in tracker)
    - src/execution/execution/manager.ts:875 (fundingGateOpen = true)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (P_low tracking after funding fee)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX bizType string for funding fee: verify exact value in the adapter (may be
    "Funding fee", "FUND", or localized variant). OKX timestamps in account.bills
    are milliseconds.

- id: strategy_2.okx.TIMING.DEADLINE_FIRES
  category: TIMING
  severity: critical
  description: >
    Deadline timer fires at deadlineAt = T_f + deadlineSeconds * 1000. Monitor
    settle('deadline') called. handleMonitorExit cancels both SL and TP (if resting)
    via cancelSiblingExit, then places a market close order.
  preconditions:
    - intent in monitoring, neither SL nor TP filled before deadline
  trigger_sequence:
    - setTimeout callback in monitor fires at deadlineAt - skewMs
    - monitor.settle('deadline') → handleMonitorExit(s, 'deadline')
  expected_behavior:
    - monitor.deadline_fired logged {deadlineAt}
    - oco.cancel.start logged for each ref (SL, TP if present)
    - order.placed {kind: "close", orderType: "market", reduceOnly: true}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'monitor.deadline_fired' {intentId, deadlineAt}
    - log: 'monitor.settle' {reason: "deadline"}
    - log: 'intent.exiting.start' {reason: "deadline"}
    - log: 'order.placed' {kind: "close", orderType: "market", reduceOnly: true}
    - log: event='intent.funding_gate_closed' {intentId: "<id>", reason: "deadline", durationMs: ">0"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:156 (deadline timer)
    - src/execution/execution/monitor.ts:157 (monitor.deadline_fired log)
    - src/execution/execution/monitor.ts:93 (monitor.settle log)
    - src/execution/execution/manager.ts:1578 (cancel SL/TP refs loop)
    - src/execution/execution/manager.ts:1660 (order.placed close log)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (Deadline at T_f + deadlineSeconds)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX algo SL/TP cancel uses cancelOrder with the algo order ID. Verify
    cancelSiblingExit handles OKX algo order cancellation correctly.

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_2.okx.OCO.SL_FILLS_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    SL stop_market fills. OKX emits on 'orders' channel with state=filled for the SL
    order. Monitor's ws.order listener detects fill (canonicalized clientOrderId matches
    slId), calls settle('sl'). handleMonitorExit cancels residual TP via cancelSiblingExit.
  preconditions:
    - intent in monitoring, SL and TP both resting
    - price drops to SL trigger level
  trigger_sequence:
    - OKX WS: 'orders' {state: "filled", clOrdId: <slClientOrderId stripped>}
    - monitor.settle('sl') → handleMonitorExit(s, 'sl')
  expected_behavior:
    - monitor.settle {reason: "sl"} logged
    - intent.exiting.start {reason: "sl"} logged
    - oco.cancel.start logged for TP ref (if TP resting)
    - oco.cancel.success logged
    - sweepReduceOnlyOrders called
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'intent.exiting.start' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: <tpClientOrderId>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
    - log: event='intent.funding_gate_closed' {intentId: "<id>", reason: "sl", durationMs: ">0"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:166 (ws.order listener for SL fill)
    - src/execution/execution/monitor.ts:177 (settle 'sl')
    - src/execution/execution/manager.ts:1502 (reason=sl: cancel tp ref)
    - src/execution/execution/manager.ts:1520 (cancelSiblingExit call)
    - src/execution/execution/manager.ts:1407 (cancelSiblingExit — OCO cancel strategies A/B/C)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (SL fills → cancel TP → exit)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    OKX SL fill arrives on 'orders' channel (not a separate algo channel for triggers).
    Monitor matches by canonicalized clientOrderId (slId). OKX clOrdId in event =
    dash-stripped form = slId registered in exitOrderRefs.

- id: strategy_2.okx.OCO.TP_FILLS_SL_CANCELED
  category: OCO
  severity: critical
  description: >
    TP limit order fills. Tracker's per-TP ws.order subscription detects fill
    (canonTpId matches). settleTp called → monitor.disarm → handleMonitorExit('tp').
    handleMonitorExit cancels SL via cancelSiblingExit.
  preconditions:
    - TP limit order resting, SL resting
    - price retraces to TP limit price
  trigger_sequence:
    - OKX WS: 'orders' {state: "filled", clOrdId: <tpClientOrderId stripped>}
    - tracker currentTpUnsub fires → settleTp(avgFillPrice)
    - monitor.disarm → handleMonitorExit(s, 'tp')
  expected_behavior:
    - intent.exiting.start {reason: "tp"} logged
    - oco.cancel.start logged for SL ref
    - oco.cancel.success logged
    - intent.exited.complete {exitReason: "tp"}
  observability_contract:
    - log: 'intent.exiting.start' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: <slClientOrderId>}
    - log: 'intent.exited.complete' {exitReason: "tp"}
    - log: event='intent.funding_gate_closed' {intentId: "<id>", reason: "tp", durationMs: ">0"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/manager.ts:935 (currentTpUnsub bus.on ws.order)
    - src/execution/execution/manager.ts:839 (settleTp on fill)
    - src/execution/execution/manager.ts:843 (monitor.disarm)
    - src/execution/execution/manager.ts:844 (handleMonitorExit 'tp')
    - src/execution/execution/manager.ts:1504 (reason=tp: cancel sl ref)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (TP fills → cancel SL → exit)
  status: ⏳
  natural_occurrence: occasional

- id: strategy_2.okx.OCO.DEADLINE_CANCELS_BOTH
  category: OCO
  severity: critical
  description: >
    Deadline fires while both SL and TP are resting. handleMonitorExit iterates
    exitOrderRefs [sl, tp] and calls cancelSiblingExit for each via strategies A/B/C,
    then places market close. OKX algo SL cancel requires algo order cancel endpoint.
  preconditions:
    - intent in monitoring, both SL and TP resting at deadline
  trigger_sequence:
    - monitor.settle('deadline') → handleMonitorExit: for ref of [sl, tp] → cancelSiblingExit
    - rest.createOrder market close
  expected_behavior:
    - oco.cancel.start logged twice (for sl, for tp)
    - oco.cancel.success or oco.cancel.exhausted for each
    - order.placed {kind: "close", orderType: "market"}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'oco.cancel.start' x2 (sl and tp refs)
    - log: 'order.placed' {kind: "close", orderType: "market", reduceOnly: true}
    - log: 'intent.exited.complete' {exitReason: "deadline"}
  code_refs:
    - src/execution/execution/manager.ts:1578 (refs = [sl, tp].filter...)
    - src/execution/execution/manager.ts:1580 (cancelSiblingExit for each ref)
    - src/execution/execution/manager.ts:1660 (order.placed close log)
    - src/execution/execution/manager.ts:1409 (cancelSiblingExit function)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (Deadline cancels SL+TP, market close)
  status: ⏳
  natural_occurrence: routine

# ── STRATEGY_SPECIFIC ────────────────────────────────────────────────────────

- id: strategy_2.okx.STRATEGY_SPECIFIC.TP_PLACED_ON_NEW_P_LOW
  category: STRATEGY_SPECIFIC
  severity: critical
  description: >
    After fundingGateOpen=true, tracker polls refPrice every 1s. When
    currentPrice < pLow AND currentPrice < anchorPrice, a new pLow is recorded
    and replaceTp is called. A TP limit order is placed at
    pLow + (anchorPrice - pLow) * retracementPct. retracement.tp_placed logged.
    OKX TP is a regular limit order (not algo) with reduceOnly=true, side=sell.
  preconditions:
    - fundingGateOpen=true
    - currentPrice < pLow (new low established)
    - currentPrice < anchorPrice
  trigger_sequence:
    - tracker tick: refPrice < pLow → replaceTp(tpPrice)
    - rest.createOrder {type: limit, price: tpPrice, reduceOnly: true, kind: tp}
  expected_behavior:
    - order.placed {kind: "tp", orderType: "limit", price: tpPrice, reduceOnly: true}
    - retracement.tp_placed logged (info level)
    - tpVersion increments to 1
  observability_contract:
    - log: 'retracement.tp_placed' {kind: "tp", orderType: "limit", price: ">0", tpVersion: 1}
    - db:orders row {kind: "tp", orderType: "limit", status: "pending"}
  code_refs:
    - src/execution/execution/manager.ts:1020 (currentPrice < pLow → replaceTp)
    - src/execution/execution/manager.ts:1026 (tpPrice calculation)
    - src/execution/execution/manager.ts:992 (retracement.tp_placed log)
    - src/execution/execution/manager.ts:929 (tpId = ids.forIntent(intent.id, 100+tpVersion++))
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (Dynamic TP at retracement level)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX limit orders with reduceOnly=true: verify OKX accepts reduceOnly on limit orders
    without rejecting (some exchanges require position hedge mode for this).
    TP clientOrderId also has dashes stripped by canonicalize() before placement.

- id: strategy_2.okx.STRATEGY_SPECIFIC.TP_REPLACED_ON_FURTHER_LOW
  category: STRATEGY_SPECIFIC
  severity: high
  description: >
    Price makes a further new low after the first TP. replaceTp called again:
    previous TP cancelled via cancelSiblingExit, new TP placed at updated tpPrice.
    tpVersion increments monotonically. OKX cancel uses the dash-stripped tpClientOrderId.
  preconditions:
    - TP already placed (currentTpCanonId set)
    - price drops below previous pLow
  trigger_sequence:
    - tracker tick: refPrice < pLow → replaceTp
    - cancelSiblingExit(currentTpRef) → place new TP
  expected_behavior:
    - oco.cancel.start logged for previous TP
    - oco.cancel.success logged
    - retracement.tp_placed logged with incremented tpVersion
  observability_contract:
    - log: 'oco.cancel.start' {clientOrderId: <old-tp-id stripped>}
    - log: 'retracement.tp_placed' {tpVersion: ">1"}
    - db:orders: old tp row cancelled, new tp row pending
  code_refs:
    - src/execution/execution/manager.ts:890 (replaceTp: cancel previous TP)
    - src/execution/execution/manager.ts:900 (cancelSiblingExit currentTpRef)
    - src/execution/execution/manager.ts:929 (new tpId)
    - src/execution/execution/manager.ts:992 (retracement.tp_placed log)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (TP tracks P_low dynamically)
  status: ⏳
  natural_occurrence: occasional

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_2.okx.WEBSOCKET.RECONNECT_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    OKX private WS disconnects and reconnects while intent is in monitoring.
    store.reconcile called on reconnect. SL and TP orders are fetched from REST.
    Deadline timer remains armed (not reset by reconnect). OKX WS reconnect requires
    re-login (WS auth token renewal).
  preconditions:
    - intent in status=monitoring, SL resting, TP may be resting
    - OKX WS disconnects and reconnects
  trigger_sequence:
    - ws.connection {state: "disconnected"} then {state: "connected"}
    - store.reconcile(exchange) called
  expected_behavior:
    - REST getOpenOrders fetched (includes SL and TP)
    - SL/TP refs still in exitOrderRefs
    - deadline timer fires at original deadlineAt
    - no duplicate exit triggered
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal — no logger.info)
    - log: event='ws.connection' {exchange: "okx", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - SL and TP orders visible in REST getOpenOrders response
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile call)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md
  status: ⏳
  natural_occurrence: occasional

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_2.okx.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_2 intent is in status=monitoring. Recovery
    rehydrates IntentState from DB including exitOrderRefs (sl, tp). manager.start()
    re-arms the monitor with sl_tp_deadline_retracement policy. canonicalize() is
    applied to all rehydrated clientOrderIds (OKX dash-stripping).
    spawnRetracementTracker is NOT re-called after recovery.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=sl_tp_deadline_retracement_funding_event
    - exitOrderRefs.sl present in DB
  trigger_sequence:
    - process restart → runRecovery() → loadActiveIntents
    - manager.start() → monitor.arm(s) for monitoring intents
  expected_behavior:
    - 'recovery: rehydrated intent states' logged (rehydratedCount >= 1)
    - monitor.armed.sl_tp_deadline_retracement logged (debug)
    - deadline timer re-armed; SL ws.order listener re-wired to slId (stripped)
    - if deadlineAt past: deadline fires immediately
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.sl_tp_deadline_retracement' {deadlineDelay, slId}  # debug
  code_refs:
    - src/execution/recovery/index.ts:132 (canonicalize applied during recovery)
    - src/execution/recovery/index.ts:245 (rehydrated intent states log)
    - src/execution/execution/manager.ts:1892 (monitor.arm for monitoring intents)
    - src/execution/execution/monitor.ts:153 (sl exitOrderRefs rehydrated)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (no recovery in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    After recovery, the retracement tracker does NOT restart. Deadline is the
    remaining exit path. If SL fires after recovery, the re-armed ws.order listener
    catches it using the dash-stripped slClientOrderId.

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_2.okx.SPEC_DIVERGENCE.FUNDING_FEE_TIMEOUT
  category: SPEC_DIVERGENCE
  severity: medium
  description: >
    Spec assumes P_low tracking begins immediately at T_f. Code adds a funding-fee
    gate: tracking only begins when ws.funding_fee received OR hard timeout fires
    (timeoutAt = T_f + fundingFeeTimeoutSeconds). OKX account.bills events are
    generally reliable but may lag by 1-3 seconds.
  preconditions:
    - ws.funding_fee delayed or missing before timeoutAt
  trigger_sequence:
    - tracker fundingGateOpen=false until timeout fires
  expected_behavior:
    - P_low tracking starts at timeoutAt, not at T_f
    - potential missed TP placement window if price already retraced
  observability_contract:
    - no 'retracement.tp_placed' log before timeoutAt (gate closed)
    - if price already retraced: TP may not be placed
  code_refs:
    - src/execution/execution/manager.ts:879 (timeoutDelay setTimeout)
    - src/execution/execution/manager.ts:822 (isFundingEventKind flag)
    - src/execution/strategies/strategy_2.ts:68 (timeoutAt computation)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (immediate tracking after T_funding)
  status: ⏳
  natural_occurrence: occasional

- id: strategy_2.okx.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active when strategy_2 intent would be submitted for okx.
    Preflight rejects with code=kill_switch before any OKX API call.
  preconditions:
    - kill switch mode != 'off'
    - strategy_2 condition met
  trigger_sequence:
    - manager.submit() → preflight → killSwitch.canPlaceOrder() returns false
  expected_behavior:
    - intent.created logged
    - intent.error logged with code=kill_switch
    - no order.placed
  observability_contract:
    - log: 'intent.error' {code: "kill_switch"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:intentLifecycleEvents decided→error
  code_refs:
    - src/execution/execution/manager.ts:2044 (preflight call)
    - src/execution/execution/manager.ts:2046 (setError on preflight fail)
  spec_refs:
    - docs-strategy/strategies/strategy_2.md (no kill switch in spec)
  status: ⏳
  natural_occurrence: occasional
```
