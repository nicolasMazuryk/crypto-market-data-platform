# Checklist — binance / strategy_3a

Exchange: **binance**
Strategy: **strategy_3a** (Negative Funding SHORT — Ride the Drop, Variant A)
Spec: `docs-strategy/strategies/strategy_3.md`
Code: `src/execution/strategies/strategy_3.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_3a.binance.ORDER_LIFECYCLE.ENTRY_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes (balance, market, qty, kill-switch).
    setLeverage succeeds. A market SELL order (SHORT) is placed via REST createOrder.
    The order.placed event is logged with kind=entry, side=sell, orderType=market,
    reduceOnly=false, and a valid exchangeOrderId echoed back by Binance.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent (negative funding required)
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - market status = trading
  trigger_sequence:
    - scheduler: evaluator fires at entryAt = nextFundingTimestamp - entryOffsetSeconds * 1000
    - manager.submit() called with strategy_3a TradeIntent (side=short)
  expected_behavior:
    - intent.created logged (status=decided)
    - intent.submitted logged (entryKind=market)
    - order.placed logged (kind=entry, side=sell, orderType=market, reduceOnly=false)
    - status transitions decided → submitted → acked → working
    - entry clientOrderId registered in byEntryOrderId map
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_3a", exchange: "binance"}
    - log: 'intent.submitted' {entryKind: "market"}
    - log: 'order.placed' {kind: "entry", side: "sell", orderType: "market", reduceOnly: false}
    - db:orders row {kind: "entry", orderType: "market", side: "sell", reduceOnly: false, status: "pending"}
    - db:intentLifecycleEvents transitions decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:2000 (intent.created log)
    - src/execution/execution/manager.ts:2081 (transition submitted)
    - src/execution/execution/manager.ts:2079 (entrySide = 'sell' for short)
    - src/execution/execution/manager.ts:2756 (order.placed log)
    - src/execution/strategies/strategy_3.ts:52 (side: 'short')
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (Entry: market SELL at T_f - 5s)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Binance REST createOrder returns exchangeOrderId in the ACK. strategy_3a always
    places a SELL (short) — side='sell', entrySide='sell'. The clientOrderId (no
    transformation on Binance) is registered in byEntryOrderId before the REST call
    so that any concurrent WS fill event arriving during the HTTP call is not lost.

- id: strategy_3a.binance.ORDER_LIFECYCLE.ENTRY_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Entry market SELL order fills immediately. Binance emits ORDER_TRADE_UPDATE on the
    user data stream with status=FILLED. Manager routes this via byEntryOrderId lookup
    (clientOrderId in field 'c'), logs order.filled, transitions to filled, then calls
    handleEntryFilled which emits position.opened (side=short) and arms the sl_tp_deadline
    monitor, placing SL + TP simultaneously.
  preconditions:
    - entry order placed and in status=working or acked
    - Binance private WS connected
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE event {X: "FILLED", c: <clientOrderId>, S: "SELL"}
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice present)
    - status transitions working → filled → monitoring
    - position.opened logged (side=short, filledQty > 0)
    - SL (buy stop_market) + TP (buy limit) placed simultaneously via REST
    - monitor.armed.sl_tp_deadline logged (debug) with deadlineDelay, slId, tpId
  observability_contract:
    - log: 'order.filled' {exchange: "binance", filledQty: ">0"}
    - log: 'position.opened' {side: "short", filledQty: ">0"}
    - log: 'order.placed' {kind: "sl", side: "buy", orderType: "stop_market", reduceOnly: true}
    - log: 'order.placed' {kind: "tp", side: "buy", orderType: "limit", reduceOnly: true}
    - log: 'monitor.armed.sl_tp_deadline' {deadlineDelay, slId, tpId}  # debug level
    - db:orders rows {kind: "sl", status: "pending"} and {kind: "tp", status: "pending"}
    - db:intentLifecycleEvents transition filled→monitoring
    - db:fills row for entry fill
  code_refs:
    - src/execution/adapters/privatews/binance.ts:48 (ORDER_TRADE_UPDATE parser)
    - src/execution/execution/manager.ts:1898 (ws.order bus handler)
    - src/execution/execution/manager.ts:1136 (handleEntryOrderEvent fill branch)
    - src/execution/execution/manager.ts:1156 (order.filled log)
    - src/execution/execution/manager.ts:782 (position.opened log)
    - src/execution/execution/manager.ts:784 (transition monitoring, monitor.arm)
    - src/execution/execution/manager.ts:406 (handleEntryFilled sl_tp_deadline branch)
    - src/execution/execution/manager.ts:409 (exitSide = 'buy' for short)
    - src/execution/execution/manager.ts:579 (order.placed sl log)
    - src/execution/execution/manager.ts:580 (order.placed tp log)
    - src/execution/execution/monitor.ts:149 (monitor.armed.sl_tp_deadline debug log)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (Entry fill → place SL + TP)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Binance uses clientOrderId field 'c' in ORDER_TRADE_UPDATE. For strategy_3a SHORT:
    exitSide='buy', SL is a buy stop_market above avgEntryPrice
    (stopPrice = avgEntryPrice × (1 + slPct/100)), TP is a buy limit below avgEntryPrice
    (price = avgEntryPrice × (1 - tpPct/100)). tpPct = |fundingRatePercent| × tpVariantAMultiplier.

- id: strategy_3a.binance.ORDER_LIFECYCLE.SL_TP_PLACED_AFTER_FILL
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Immediately after the entry fill is confirmed (handleEntryFilled), manager places
    SL and TP simultaneously via Promise.allSettled. For strategy_3a SHORT:
    SL = buy stop_market at avgEntryPrice × (1 + slPct/100);
    TP = buy limit at avgEntryPrice × (1 - tpPct/100).
    Both are reduceOnly=true, side=buy.
  preconditions:
    - entry fill confirmed (status=filled)
    - avgEntryPrice available (from WS fill event)
  trigger_sequence:
    - handleEntryFilled called → sl_tp_deadline branch entered
    - Promise.allSettled([rest.createOrder(sl), rest.createOrder(tp)])
  expected_behavior:
    - SL placed at price > avgEntryPrice (stop_market, buy)
    - TP placed at price < avgEntryPrice (limit, buy)
    - exitOrderRefs.sl and exitOrderRefs.tp populated
    - pollForSlTpFill started (15s × 50 safety net)
  observability_contract:
    - log: 'order.placed' {kind: "sl", side: "buy", orderType: "stop_market", stopPrice: ">avgEntryPrice"}
    - log: 'order.placed' {kind: "tp", side: "buy", orderType: "limit", price: "<avgEntryPrice"}
    - db:orders {kind: "sl", reduceOnly: true, side: "buy"}
    - db:orders {kind: "tp", reduceOnly: true, side: "buy"}
  code_refs:
    - src/execution/execution/manager.ts:406 (sl_tp_deadline branch)
    - src/execution/execution/manager.ts:409 (exitSide = 'buy' for short)
    - src/execution/execution/manager.ts:458 (slPrice = price * (1 + slPct/100) for short)
    - src/execution/execution/manager.ts:459 (tpPrice = price * (1 - tpPct/100) for short)
    - src/execution/execution/manager.ts:498 (Promise.allSettled createOrder sl + tp)
    - src/execution/execution/manager.ts:786 (pollForSlTpFill started)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (SL + TP placed simultaneously after fill)
  status: ⏳
  natural_occurrence: routine
  notes: >
    The SL stop price for a SHORT is ABOVE entry (price rises → loss). TP limit is BELOW
    entry (price falls → profit). This is the inverse of LONG strategies.

- id: strategy_3a.binance.ORDER_LIFECYCLE.SL_PLACEMENT_FAILS_PROTECTIVE_CLOSE
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    One or both of SL/TP REST createOrder calls fail (e.g. exchange rejects, network error).
    Manager logs 'manager: protective order placement failed' at error level, then calls
    closeAfterProtectionFailure which places an immediate market close (buy side, reduceOnly)
    with code=protective_order_failed.
  preconditions:
    - entry filled (short position open)
    - SL and/or TP createOrder returns rejected or throws
  trigger_sequence:
    - Promise.allSettled resolves with one or both rejected
    - slReject or tpReject truthy → closeAfterProtectionFailure called
  expected_behavior:
    - 'manager: protective order placement failed' logged at error level (slReject, tpReject fields)
    - market close (buy, reduceOnly) placed immediately
    - intent.error logged with code=protective_order_failed
  observability_contract:
    - log: 'manager: protective order placement failed' {slReject, tpReject} (error level)
    - log: 'intent.error' {code: "protective_order_failed"}
    - log: 'order.placed' {kind: "close", side: "buy", orderType: "market", reduceOnly: true}
    - db:intentLifecycleEvents monitoring→error
  code_refs:
    - src/execution/execution/manager.ts:538 (slReject or tpReject check)
    - src/execution/execution/manager.ts:539 (protective order placement failed log)
    - src/execution/execution/manager.ts:540 (closeAfterProtectionFailure call)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (no error handling in spec)
  status: ⏳
  natural_occurrence: rare
  notes: >
    Binance may reject stop orders with -2021 (Stop price would trigger immediately)
    if slPct is too small relative to current spread. In that case tpReject is null
    but slReject is set.

- id: strategy_3a.binance.ORDER_LIFECYCLE.TP_FILLS_FIRST
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    TP limit buy order fills (price dropped to tpPrice). Monitor receives ws.order event
    with clientOrderId matching tpId and status=filled. settle('tp') is called.
    handleMonitorExit cancels SL via cancelSiblingExit, then sweeps, records metrics,
    and transitions to exited with reason=tp.
  preconditions:
    - intent in status=monitoring
    - TP limit order resting on exchange
    - market price drops to TP level (SHORT profits on drop)
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {X: "FILLED", c: <tpClientOrderId>}
    - monitor ws.order listener matches tpId → settle('tp')
    - handleMonitorExit called with reason='tp'
  expected_behavior:
    - monitor.settle logged with reason=tp
    - intent.exiting.start logged (reason=tp)
    - SL canceled via cancelSiblingExit (oco.cancel.start, oco.cancel.success)
    - oco.sweep.complete logged
    - intent.exited.complete logged (exitReason=tp)
  observability_contract:
    - log: 'monitor.settle' {reason: "tp"}
    - log: 'intent.exiting.start' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: "<sl-id>"}
    - log: 'oco.cancel.success' {strategy: "A"}
    - log: 'oco.sweep.complete' {failedCount: 0, foundOrderIds: []}
    - log: 'intent.exited.complete' {exitReason: "tp"}
    - db:intentLifecycleEvents monitoring→exiting→exited
    - db:realizedPnl row (positive for a profitable TP)
  code_refs:
    - src/execution/execution/monitor.ts:136 (tpId match → settle tp)
    - src/execution/execution/manager.ts:1502 (reason=tp branch in handleMonitorExit)
    - src/execution/execution/manager.ts:1504 (residualRef = sl ref)
    - src/execution/execution/manager.ts:1520 (cancelSiblingExit called)
    - src/execution/execution/manager.ts:1565 (intent.exited.complete log)
    - src/execution/execution/manager.ts:1409 (cancelSiblingExit function)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (TP fills → cancel SL, exit)
  status: ⏳
  natural_occurrence: routine
  notes: >
    For a SHORT, TP fires when price drops. The tpPrice = avgEntryPrice × (1 - tpPct/100).
    The WS fill event matches tpId because Binance echoes back the clientOrderId in field 'c'.

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_3a.binance.TIMING.ENTRY_AT_CORRECT_OFFSET
  category: TIMING
  severity: high
  description: >
    Entry SELL order is placed at approximately T_f - 5s (entryOffsetSeconds=5).
    entryAt = nextFundingTimestamp - entryOffsetSeconds * 1000. Order.placed timestamp
    should be within a few hundred milliseconds after entryAt.
  preconditions:
    - scheduler running and synced
    - strategy condition met (fundingRatePercent < -threshold)
  trigger_sequence:
    - scheduler fires evaluate() at entryAt
  expected_behavior:
    - intent.submitted timestamp within ≤1000ms after entryAt
    - order.placed (kind=entry, side=sell) within ≤2000ms after entryAt
  observability_contract:
    - log: 'intent.submitted' timestamp ≤ entryAt + 1000ms
    - log: 'order.placed' {kind: "entry", side: "sell"} timestamp ≤ entryAt + 2000ms
  code_refs:
    - src/execution/strategies/strategy_3.ts:43 (entryAt = nextFundingTimestamp - entryOffsetSeconds*1000)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (Entry at T_f - 5s)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Entry offset is configurable (entryOffsetSeconds). Default is 5s before funding time.

- id: strategy_3a.binance.TIMING.DEADLINE_FIRES_MARKET_CLOSE
  category: TIMING
  severity: critical
  description: >
    Deadline timer fires at T_f + deadlineSeconds (after the funding event). Neither SL
    nor TP has filled. monitor.deadline_fired is logged. settle('deadline') is called.
    handleMonitorExit cancels both SL and TP, then places a market BUY reduceOnly close.
  preconditions:
    - intent in status=monitoring
    - neither SL nor TP has filled before deadlineAt
  trigger_sequence:
    - setTimeout fires at deadlineAt (= nextFundingTimestamp + deadlineSeconds * 1000)
    - settle('deadline', {source: 'timer'})
    - handleMonitorExit called with reason='deadline'
  expected_behavior:
    - monitor.deadline_fired logged {deadlineAt}
    - intent.exiting.start logged (reason=deadline)
    - SL and TP both canceled via cancelSiblingExit
    - market close (kind=close, side=buy, reduceOnly=true) placed
    - intent.exited.complete logged (via REST poll path if WS close fill missed)
  observability_contract:
    - log: 'monitor.deadline_fired' {deadlineAt}
    - log: 'monitor.settle' {reason: "deadline"}
    - log: 'intent.exiting.start' {reason: "deadline"}
    - log: 'order.placed' {kind: "close", side: "buy", orderType: "market", reduceOnly: true}
    - log: 'oco.cancel.start' (twice — once for SL, once for TP)
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:112 (deadlineDelay = deadlineAt - now - skewMs)
    - src/execution/execution/monitor.ts:114 (monitor.deadline_fired log)
    - src/execution/execution/monitor.ts:115 (settle 'deadline')
    - src/execution/execution/manager.ts:1576 (deadline branch → cancel SL + TP refs)
    - src/execution/execution/manager.ts:1585 (closeKind = 'close')
    - src/execution/execution/manager.ts:1660 (order.placed close log)
    - src/execution/strategies/strategy_3.ts:67 (deadlineAt = nextFundingTimestamp + deadlineSeconds*1000)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (Deadline exit)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    deadlineAt is set in the intent at strategy creation time. The close order is a
    market BUY (side=buy) because this is a SHORT position. pollForCloseFill runs after
    the close is placed as a REST fallback for fill detection.

- id: strategy_3a.binance.TIMING.ENTRY_FILL_REST_POLL_FALLBACK
  category: TIMING
  severity: high
  description: >
    WS ORDER_TRADE_UPDATE fill event for the entry SELL order does not arrive (brief WS
    gap). The REST poll fallback (pollForEntryFill, 15 polls × 1s) detects the fill via
    getOrder and drives the intent to filled → monitoring, placing SL + TP.
  preconditions:
    - entry order placed (status=working)
    - WS fill event not received within ~1s
  trigger_sequence:
    - pollForEntryFill loop: getOrder returns status=filled
    - handleEntryOrderEvent called from poll
  expected_behavior:
    - order.filled logged (from poll, not WS)
    - position.opened logged (side=short)
    - SL + TP placed
    - monitor.armed.sl_tp_deadline logged
  observability_contract:
    - log: 'order.filled' (from poll)
    - log: 'position.opened' {side: "short"}
    - log: 'order.placed' {kind: "sl", side: "buy"}
    - log: 'order.placed' {kind: "tp", side: "buy"}
    - db:intentLifecycleEvents working→filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:1179 (pollForEntryFill)
    - src/execution/execution/manager.ts:1194 (handleEntryOrderEvent from poll)
    - src/execution/execution/manager.ts:2786 (poll started after REST ack)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (no poll fallback in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    On Binance, WS fill events for market orders are reliable. The poll fallback is a
    safety net. If both WS and poll detect the fill, the second is idempotent (TERMINAL
    guard at manager.ts:1138).

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_3a.binance.OCO.SL_FIRES_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    SL stop_market buy order fills (price rose above stop price — loss on SHORT).
    Monitor ws.order listener matches slId, settle('sl') called. handleMonitorExit
    cancels TP limit buy via cancelSiblingExit, sweeps, exits with reason=sl.
  preconditions:
    - intent in status=monitoring
    - market price rises above SL stop price
  trigger_sequence:
    - Binance triggers stop → ORDER_TRADE_UPDATE {X: "FILLED", c: <slClientOrderId>}
    - monitor matches slId → settle('sl')
    - handleMonitorExit(reason='sl') cancels tpRef
  expected_behavior:
    - monitor.settle logged with reason=sl
    - oco.cancel.start for TP
    - oco.cancel.success (strategy A)
    - oco.sweep.complete {foundCount: 0}
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'intent.exiting.start' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: "<tp-id>"}
    - log: 'oco.cancel.success' {strategy: "A"}
    - log: 'intent.exited.complete' {exitReason: "sl"}
    - db:orders {kind: "tp", status: "cancelled"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:127 (slId match → settle sl)
    - src/execution/execution/manager.ts:1502 (reason=sl branch)
    - src/execution/execution/manager.ts:1504 (residualRef = tp ref)
    - src/execution/execution/manager.ts:1520 (cancelSiblingExit)
    - src/execution/execution/manager.ts:1409 (cancelSiblingExit: A→B→C strategies)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (SL fires → cancel TP, exit)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Binance stop_market orders are triggered server-side. The WS event carries the
    clientOrderId in field 'c', matching slId directly.

- id: strategy_3a.binance.OCO.TP_FIRES_SL_CANCELED
  category: OCO
  severity: critical
  description: >
    TP limit buy fills (market dropped to tpPrice — profit on SHORT). Monitor matches
    tpId, settle('tp') called. SL stop_market is canceled via cancelSiblingExit.
    Intent exits with reason=tp.
  preconditions:
    - intent in status=monitoring
    - market price drops to TP limit price
  trigger_sequence:
    - Binance fills limit buy → ORDER_TRADE_UPDATE {X: "FILLED", c: <tpClientOrderId>}
    - monitor matches tpId → settle('tp')
  expected_behavior:
    - oco.cancel.start for SL
    - oco.cancel.success
    - intent.exited.complete {exitReason: "tp"}
  observability_contract:
    - log: 'monitor.settle' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: "<sl-id>"}
    - log: 'intent.exited.complete' {exitReason: "tp"}
    - db:orders {kind: "sl", status: "cancelled"}
  code_refs:
    - src/execution/execution/monitor.ts:136 (tpId match → settle tp)
    - src/execution/execution/manager.ts:1502 (reason=tp branch)
    - src/execution/execution/manager.ts:1564 (transition exited)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (TP fires → cancel SL, exit)
  status: ⏳
  natural_occurrence: routine
  notes: >
    For SHORT: TP fires when price drops, SL fires when price rises. Both exit orders
    are on the BUY side.

- id: strategy_3a.binance.OCO.DEADLINE_CANCELS_BOTH_SL_TP
  category: OCO
  severity: high
  description: >
    Deadline fires before either SL or TP fills. handleMonitorExit iterates
    exitOrderRefs (sl, tp) and calls cancelSiblingExit for each, then places market close.
  preconditions:
    - intent in monitoring, both SL and TP still resting
    - deadlineAt reached
  trigger_sequence:
    - setTimeout fires → settle('deadline')
    - handleMonitorExit iterates [slRef, tpRef] and calls cancelSiblingExit for each
  expected_behavior:
    - oco.cancel.start logged twice (once for sl, once for tp)
    - market BUY reduceOnly close placed after cancels
    - intent exits with reason=deadline
  observability_contract:
    - log: 'oco.cancel.start' x2 (sl ref, tp ref)
    - log: 'order.placed' {kind: "close", side: "buy", reduceOnly: true}
    - log: 'intent.exited.complete' {exitReason: "deadline"} (via REST poll)
  code_refs:
    - src/execution/execution/manager.ts:1578 (iterate exitOrderRefs for deadline)
    - src/execution/execution/manager.ts:1579 (refs = [sl, tp] refs)
    - src/execution/execution/manager.ts:1581 (cancelSiblingExit per ref)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (Deadline: cancel SL+TP, market close)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    The two cancelSiblingExit calls are sequential (for...of loop). Each goes through
    strategies A→B→C. On Binance, strategy A (clientOrderId cancel) typically succeeds.

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_3a.binance.WEBSOCKET.RECONNECT_RECONCILE_SL_TP_RESTING
  category: WEBSOCKET
  severity: high
  description: >
    Binance private WS disconnects and reconnects while intent is in monitoring (SL + TP
    resting). store.reconcile() fetches open orders and positions via REST. SL and TP
    remain in exitOrderRefs. Monitor remains armed (deadline timer not reset). No
    spurious exit triggered.
  preconditions:
    - intent in status=monitoring
    - SL + TP resting on exchange
    - WS disconnects then reconnects
  trigger_sequence:
    - ws.connection event: {state: "disconnected"}
    - ws.connection event: {state: "connected"}
    - store.reconcile() called
  expected_behavior:
    - store.reconcile fetches positions + open orders
    - SL + TP still in exitOrderRefs
    - deadline timer continues (was not cleared by reconnect)
    - no duplicate exit triggered
  observability_contract:
    - bus: 'ws.connection' {state: "connected"}
    - log: event='ws.connection' {exchange: "binance", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - db:orders {kind: "sl"} and {kind: "tp"} remain status=pending (no cancel)
    - no spurious 'monitor.settle' log
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile on reconnect)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (no WS reconnect handling in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    The deadline timer set in monitor.arm is NOT reset by reconnect — it continues to
    fire at the original deadlineAt. pollForSlTpFill also continues running during the
    reconnect gap.

- id: strategy_3a.binance.WEBSOCKET.POLL_FOR_SL_TP_FILL_DETECTS_FILL
  category: WEBSOCKET
  severity: high
  description: >
    pollForSlTpFill (15s interval, up to 50 polls) detects SL or TP fill via REST getOrder
    when the WS fill event was missed (e.g. reconnect gap during fill). Detects filled
    status, disarms monitor, calls handleMonitorExit with appropriate reason.
  preconditions:
    - intent in monitoring, SL + TP resting
    - WS fill event for SL or TP not received
  trigger_sequence:
    - pollForSlTpFill: after 15s delay, getOrder(slRef) returns status=filled
    - monitor.disarm called, handleMonitorExit('sl') called
  expected_behavior:
    - 'order.filled' NOT logged by WS (missed)
    - monitor.settle fires from poll path
    - handleMonitorExit runs (cancel sibling, sweep, exit)
    - intent.exited.complete logged
  observability_contract:
    - log: 'intent.exiting.start' {reason: "sl" or "tp"} (from poll-triggered exit)
    - log: 'intent.exited.complete' {exitReason: "sl" or "tp"}
    - no prior ws-sourced 'monitor.settle' log for this intent
  code_refs:
    - src/execution/execution/manager.ts:1299 (pollForSlTpFill)
    - src/execution/execution/manager.ts:1306 (POLL_INTERVAL_MS = 15_000)
    - src/execution/execution/manager.ts:1307 (MAX_POLLS = 50)
    - src/execution/execution/manager.ts:1322 (slOrder filled → handleMonitorExit sl)
    - src/execution/execution/manager.ts:1337 (tpOrder filled → handleMonitorExit tp)
    - src/execution/execution/manager.ts:786 (pollForSlTpFill started after monitor.arm)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (no poll fallback in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    pollForSlTpFill is the critical safety net for SL/TP fill detection on all exchanges.
    15s interval means detection may lag by up to 15s after the actual fill. The 50-poll
    limit (~12.5 min) covers typical deadline windows.

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_3a.binance.RECOVERY.RESTART_IN_MONITORING_SL_TP_REHYDRATED
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while a strategy_3a intent is in status=monitoring (entry filled,
    SL + TP resting). Recovery rehydrates IntentState from DB including exitOrderRefs
    (sl=stop_market ref, tp=limit ref). manager.start() re-arms the monitor with
    sl_tp_deadline policy. Deadline timer and ws.order listener are re-established.
    pollForSlTpFill re-started.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=sl_tp_deadline
    - exitOrderRefs.sl and exitOrderRefs.tp populated in DB
    - deadlineAt in the future
  trigger_sequence:
    - process restart
    - runRecovery() called → loadActiveIntents → rehydrateIntentState
    - manager.start() calls monitor.arm for all monitoring intents
  expected_behavior:
    - 'recovery: rehydrated intent states' logged (rehydratedCount ≥ 1)
    - monitor.armed.sl_tp_deadline logged (debug) with slId, tpId from exitOrderRefs
    - deadline timer re-armed (delay = deadlineAt - now)
    - pollForSlTpFill re-started
    - normal exit flow continues (SL, TP, or deadline)
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: "≥1"}
    - log: 'monitor.armed.sl_tp_deadline' {slId, tpId, deadlineDelay}  # debug
    - db:orders exitOrderRefs show sl and tp refs with clientOrderIds
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated intent states log)
    - src/execution/execution/manager.ts:1888 (start — re-arm monitoring intents)
    - src/execution/execution/manager.ts:1892 (monitor.arm for status=monitoring)
    - src/execution/execution/monitor.ts:108 (sl_tp_deadline arm branch)
    - src/execution/execution/manager.ts:786 (pollForSlTpFill re-started in arm)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (no recovery in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Critical distinction from strategy_1/2: exitOrderRefs must contain BOTH sl and tp
    refs for the monitor to match WS fill events. If exitOrderRefs is missing from DB
    (durability write failed), the monitor arms without slId/tpId and only the deadline
    timer fires — a degraded-mode recovery.

# ── STRATEGY_SPECIFIC ────────────────────────────────────────────────────────

- id: strategy_3a.binance.STRATEGY_SPECIFIC.SHORT_DIRECTION_VERIFIED
  category: STRATEGY_SPECIFIC
  severity: critical
  description: >
    Verify that all order sides are correct for a SHORT strategy. Entry is SELL,
    exit orders (SL and TP) are BUY side. SL stop price is ABOVE entry price,
    TP limit price is BELOW entry price. Position side is 'short'.
  preconditions:
    - strategy_3a intent submitted and filled
  trigger_sequence:
    - observe all order.placed events for a single intent lifecycle
  expected_behavior:
    - order.placed (entry): side=sell
    - order.placed (sl): side=buy, orderType=stop_market, stopPrice > avgEntryPrice
    - order.placed (tp): side=buy, orderType=limit, price < avgEntryPrice
    - position.opened: side=short
  observability_contract:
    - log: 'order.placed' {kind: "entry", side: "sell"}
    - log: 'position.opened' {side: "short"}
    - log: 'order.placed' {kind: "sl", side: "buy", stopPrice: ">avgEntryPrice"}
    - log: 'order.placed' {kind: "tp", side: "buy", price: "<avgEntryPrice"}
    - log: 'order.placed' {kind: "close", side: "buy"} (if deadline fires)
  code_refs:
    - src/execution/strategies/strategy_3.ts:52 (side: 'short')
    - src/execution/execution/manager.ts:2079 (entrySide = 'sell' for short)
    - src/execution/execution/manager.ts:409 (exitSide = 'buy' for short)
    - src/execution/execution/manager.ts:458 (slPrice = price * (1 + slPct/100))
    - src/execution/execution/manager.ts:459 (tpPrice = price * (1 - tpPct/100))
    - src/execution/execution/manager.ts:1500 (exitSide = 'buy' for close)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (SHORT — entry sell, exits buy)
  status: ⏳
  natural_occurrence: routine
  notes: >
    This is the most important strategy_3a invariant. Any mix-up between buy/sell
    directions would result in doubling the position rather than closing it.

- id: strategy_3a.binance.STRATEGY_SPECIFIC.TP_VARIANT_A_COMPUTED
  category: STRATEGY_SPECIFIC
  severity: medium
  description: >
    tpPct for variant A is computed as |fundingRatePercent| × tpVariantAMultiplier.
    The tpVariant field in exitPolicy is 'A' (audit label). The actual tpPct is encoded
    in exitPolicy.tpPct and drives TP price placement.
  preconditions:
    - strategy_3a intent evaluated and submitted
  trigger_sequence:
    - strategy_3.ts evaluate() computes tpPct = Math.abs(snap.fundingRatePercent) * config.tpVariantAMultiplier
  expected_behavior:
    - tpPct > 0 and proportional to |fundingRatePercent|
    - TP price = avgEntryPrice × (1 - tpPct/100) [for SHORT]
    - tpVariant='A' in exitPolicy (audit label, not read by manager)
  observability_contract:
    - db:trade_intents exitPolicy.tpPct = |fundingRatePercent| * tpVariantAMultiplier
    - db:trade_intents exitPolicy.tpVariant = "A"
    - log: 'order.placed' {kind: "tp", price: "=avgEntryPrice*(1-tpPct/100)"}
  code_refs:
    - src/execution/strategies/strategy_3.ts:39 (tpPct = Math.abs * tpVariantAMultiplier)
    - src/execution/strategies/strategy_3.ts:65 (exitPolicy.tpPct)
    - src/execution/strategies/strategy_3.ts:68 (tpVariant: config.tpVariant)
    - src/execution/execution/manager.ts:459 (tpPrice = price * (1 - tpPct/100))
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (Variant A: TP = |F| × multiplier)
  status: ⏳
  natural_occurrence: routine
  notes: >
    tpVariantAMultiplier is a config parameter (e.g. 1.5). A funding rate of -0.5% →
    tpPct = 0.5 × 1.5 = 0.75%. TP is placed 0.75% below avgEntryPrice.

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_3a.binance.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active (mode != 'off') blocks the intent before any order is placed.
    Preflight rejects with code=kill_switch. The spec has no kill switch concept.
  preconditions:
    - kill switch mode != 'off'
    - strategy_3a condition met (negative funding, balance OK)
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
    - db:orders no entry for this intentId
  code_refs:
    - src/execution/execution/manager.ts:2044 (preflight call)
    - src/execution/execution/manager.ts:2046 (setError on preflight fail)
  spec_refs:
    - docs-strategy/strategies/strategy_3.md (no kill switch in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Kill switch is the emergency stop for all strategies. It blocks strategy_3a entries
    just as it blocks strategy_1/2. If kill switch activates while an intent is already
    in monitoring, cancelIntent → handleMonitorExit('kill_switch') closes the position.
```
