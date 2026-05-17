# Checklist — bybit / strategy_1

Exchange: **bybit**
Strategy: **strategy_1** (Negative Funding LONG — Instant Exit)
Spec: `docs-strategy/strategies/strategy_1.md`
Code: `src/execution/strategies/strategy_1.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_1.bybit.ORDER_LIFECYCLE.ENTRY_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Entry market order fills immediately. Bybit emits an 'order' topic event on the
    private WS with orderStatus=Filled. Manager routes this via byEntryOrderId lookup
    using the orderLinkId field (mapped to clientOrderId), logs order.filled, transitions
    to filled, then calls handleEntryFilled which emits position.opened and arms the
    timed monitor.
  preconditions:
    - entry order placed and in status=working or acked
    - Bybit private WS connected
  trigger_sequence:
    - Bybit WS: topic='order' {orderStatus: "Filled", orderLinkId: <clientOrderId>}
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice present)
    - status transitions working → filled → monitoring
    - position.opened logged (side=long, filledQty > 0)
    - monitor.armed.timed logged (debug) with delay to T_f + exitOffsetSeconds
    - no SL/TP orders placed
  observability_contract:
    - log: 'order.filled' {exchange: "bybit", filledQty: ">0"}
    - log: 'position.opened' {side: "long", filledQty: ">0"}
    - log: 'monitor.armed.timed' {delay: "~7000ms from now"}  # debug level
    - db:orders row {kind: "entry", status: "filled", filledQty: ">0"}
    - db:intentLifecycleEvents transition filled→monitoring
    - db:fills row for entry fill
  code_refs:
    - src/execution/execution/manager.ts:1898 (ws.order bus handler)
    - src/execution/execution/manager.ts:1136 (handleEntryOrderEvent fill branch)
    - src/execution/execution/manager.ts:1157 (transition filled)
    - src/execution/execution/manager.ts:773 (position.opened emit/log in handleEntryFilled)
    - src/execution/execution/manager.ts:784 (transition monitoring, monitor.arm)
    - src/execution/execution/monitor.ts:97 (arm timed branch)
    - src/execution/adapters/privatews/bybit-mapping.ts:88 (topic='order' parser)
    - src/execution/adapters/privatews/bybit-mapping.ts:97 (orderLinkId → clientOrderId)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (Execution Flow step 1)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Bybit uses the 'order' topic (NOT ORDER_TRADE_UPDATE). clientOrderId is sourced from
    the orderLinkId field. Timestamps (createdTime, updatedTime) are in MICROSECONDS
    when > 9_999_999_999_999 — the mapping divides by 1000 before emitting (bybit-mapping.ts:104-105).
    avgFillPrice is in the avgPrice field; present on Filled status for market orders.

- id: strategy_1.bybit.ORDER_LIFECYCLE.ENTRY_PARTIAL_THEN_FULL_FILL
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Entry market order partially fills (e.g. split across ticks), then fills fully.
    Bybit emits 'order' topic events with orderStatus=PartiallyFilled then Filled.
    Manager logs intermediate partially_filled state, then fill completes normally.
  preconditions:
    - entry order in status=working
    - Bybit emits PartiallyFilled then Filled 'order' topic events
  trigger_sequence:
    - Bybit WS: topic='order' {orderStatus: "PartiallyFilled", orderLinkId: <clientOrderId>}
    - Bybit WS: topic='order' {orderStatus: "Filled", orderLinkId: <clientOrderId>}
  expected_behavior:
    - status transitions working → partially_filled (on partial)
    - status transitions partially_filled → filled (on full fill)
    - order.filled logged once on Filled event
    - position.opened logged
    - monitor armed
  observability_contract:
    - db:intentLifecycleEvents transition working→partially_filled then partially_filled→filled
    - log: 'order.filled' {filledQty: "total qty"} (emitted on Filled, not on PartiallyFilled)
    - log: 'position.opened' {side: "long"}
  code_refs:
    - src/execution/execution/manager.ts:1159 (partially_filled transition)
    - src/execution/execution/manager.ts:1136 (Filled branch)
    - src/execution/adapters/privatews/bybit-mapping.ts:67 (mapBybitOrderStatus PartiallyFilled)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (Execution Flow step 1)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Market orders on Bybit rarely produce partial fills but can in thin markets.
    The partial fill is tracked in state.filledQty but handleEntryFilled is only
    called once, on the final Filled event.

- id: strategy_1.bybit.ORDER_LIFECYCLE.ENTRY_REJECTED_INSUFFICIENT_BALANCE
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Preflight check fires before order placement. Available USDT balance is less than
    required margin (amountUsd / leverage). Intent transitions to error without any
    order reaching the exchange.
  preconditions:
    - available USDT < amountUsd / leverage
  trigger_sequence:
    - manager.submit() called; preflight runs balance check
  expected_behavior:
    - intent.created logged
    - intent.error logged with code=insufficient_balance
    - no order.placed log
    - status transitions decided → error (terminal)
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_1"}
    - log: 'intent.error' {code: "insufficient_balance"}
    - db:intentLifecycleEvents decided→error (no working or submitted rows)
    - db:orders no entry for this intentId
  code_refs:
    - src/execution/execution/preflight.ts:77 (balance check)
    - src/execution/execution/manager.ts:2044 (preflight call)
    - src/execution/execution/manager.ts:2046 (setError on preflight fail)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (Selection Logic — no balance check in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Bybit REST error code 110071 (insufficient balance) is never seen here because
    the preflight check runs before the REST call. The preflight code=insufficient_balance
    is the observable signal. Bybit numeric error 110001 (order not found) may appear
    in cancel scenarios but not here.

- id: strategy_1.bybit.ORDER_LIFECYCLE.TIMED_CLOSE_PLACED_AND_FILLED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Monitor timer fires at T_f + exitOffsetSeconds. handleMonitorExit places a market
    SELL reduce-only order (kind=timed). Bybit fills it immediately and emits an 'order'
    topic event with orderStatus=Filled. Manager detects fill via byCloseOrderId,
    logs order.filled for the close, transitions to exited.
  preconditions:
    - intent in status=monitoring
    - timer has fired (reason=timed)
  trigger_sequence:
    - monitor: settle('timed', ...) → bus.emit('exit.triggered')
    - manager: handleMonitorExit → REST createOrder (market, reduceOnly=true, kind=timed)
    - Bybit WS: topic='order' {orderStatus: "Filled", orderLinkId: <closeClientOrderId>}
  expected_behavior:
    - intent.exiting.start logged (reason=timed)
    - order.placed logged (kind=timed, side=sell, orderType=market, reduceOnly=true)
    - status transitions monitoring → exiting
    - order.filled logged for close order
    - status transitions exiting → exited
    - oco.sweep.start/complete logged (debug, will find 0 reduce-only orders)
  observability_contract:
    - log: 'monitor.exit_requested' {reason: "timed"}
    - log: 'monitor.settle' {reason: "timed"}
    - log: 'intent.exiting.start' {reason: "timed"}
    - log: 'order.placed' {kind: "timed", side: "sell", orderType: "market", reduceOnly: true}
    - log: 'order.filled' {clientOrderId: "<close-order-id>"}
    - db:orders {kind: "timed", status: "filled"}
    - db:intentLifecycleEvents monitoring→exiting→exited
    - db:realizedPnl row for this intent
  code_refs:
    - src/execution/execution/monitor.ts:99 (timer settle timed)
    - src/execution/execution/monitor.ts:93 (monitor.exit_requested log)
    - src/execution/execution/manager.ts:1479 (intent.exiting.start)
    - src/execution/execution/manager.ts:1585 (closeKind = timed)
    - src/execution/execution/manager.ts:1610 (createOrder close)
    - src/execution/execution/manager.ts:1660 (order.placed close)
    - src/execution/execution/manager.ts:1914 (ws.order close fill handler)
    - src/execution/execution/manager.ts:1931 (transition exited)
    - src/execution/execution/manager.ts:1933 (sweepReduceOnlyOrders)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (Execution Flow step 2)
  status: ⏳
  natural_occurrence: routine
  notes: >
    This is the happy-path exit — the most important scenario to observe first.
    Note: the WS close fill handler (line 1914) does NOT log 'intent.exited.complete';
    that log appears only on the REST poll path. Reliable exit signal is the
    'order.filled' log for the close order (kind=timed) + db:exited transition.
    Bybit close fill arrives on 'order' topic with orderLinkId matching the close clientOrderId.

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_1.bybit.TIMING.TIMED_EXIT_FIRES_AT_CORRECT_OFFSET
  category: TIMING
  severity: critical
  description: >
    Monitor timer fires at T_f + exitOffsetSeconds (default 2s). The monitor calculates
    delay = max(0, exitAt - now - skewMs). Latency from exitAt to market close order
    placed should be within a few hundred ms (timer resolution + REST round-trip).
  preconditions:
    - intent in monitoring state
    - monitor armed with timed exit policy
  trigger_sequence:
    - setTimeout callback fires at exitAt - skewMs
  expected_behavior:
    - monitor.settle logged with source=timer, latencyMs measurable
    - intent.exiting.start logged within ≤500ms of exitAt
    - order.placed (kind=timed) within ≤2000ms of exitAt
  observability_contract:
    - log: 'monitor.settle' {reason: "timed", source: "timer", latencyMs: "<500"}
    - log: 'intent.exiting.start' {reason: "timed"}
    - log: 'order.placed' {kind: "timed"} timestamp ≤ exitAt + 2000ms
  code_refs:
    - src/execution/execution/monitor.ts:97 (timed arm)
    - src/execution/execution/monitor.ts:99 (settle call)
    - src/execution/execution/monitor.ts:73 (skewMs factored into delay)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (Exit time T_exit = T_funding + 2s)
  status: ⏳
  natural_occurrence: routine
  notes: >
    skewMs is per-exchange, sourced from clock.skewMs(intent.exchange). On Bybit,
    this is typically < 100ms if the server clocks are synchronized.

- id: strategy_1.bybit.TIMING.ENTRY_FILL_REST_POLL_FALLBACK
  category: TIMING
  severity: high
  description: >
    WS 'order' topic fill event for the entry order does not arrive (e.g. brief WS gap).
    The REST poll fallback (pollForEntryFill, 15 polls × 1s) detects the fill via
    getOrder and drives the intent to filled → monitoring.
  preconditions:
    - entry order placed (status=working)
    - WS fill event not received
  trigger_sequence:
    - pollForEntryFill loop: getOrder returns status=filled
  expected_behavior:
    - order.filled logged (from poll, not WS)
    - status transitions working → filled → monitoring
    - position.opened logged
    - monitor armed
  observability_contract:
    - log: 'order.filled' (from handleEntryOrderEvent called by poll, not WS handler)
    - log: 'position.opened'
    - db:intentLifecycleEvents working→filled→monitoring
    - no prior 'order.filled' log (WS path would emit it earlier if WS worked)
  code_refs:
    - src/execution/execution/manager.ts:1179 (pollForEntryFill)
    - src/execution/execution/manager.ts:1194 (handleEntryOrderEvent from poll)
    - src/execution/execution/manager.ts:2787 (poll started after REST ack)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (no poll fallback in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    On Bybit, the WS 'order' topic fill event is reliable for market orders. The poll
    fallback is a safety net. If both WS and poll detect the fill, the second detection
    is idempotent (TERMINAL guard prevents double-handling).

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_1.bybit.WEBSOCKET.RECONNECT_TRIGGERS_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    Bybit private WS disconnects and reconnects while intent is in monitoring.
    The state store listener detects ws.connection transition to 'connected' (from
    non-connected) and calls store.reconcile(). reconcile() fetches open orders and
    positions from REST, updating the in-memory state maps.
  preconditions:
    - intent in status=monitoring
    - WS disconnects then reconnects
  trigger_sequence:
    - ws.connection event: {state: "disconnected"}
    - ws.connection event: {state: "connected"}
  expected_behavior:
    - store.reconcile() called → REST getOpenOrders + getPositions fetched
    - state maps updated (positions, balances, orders)
    - timed monitor NOT re-armed by reconnect (it remains armed from fill)
    - no duplicate exit triggered
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal bus event — no logger.info)
    - log: event='ws.connection' {exchange: "bybit", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - log: 'store.reconcile.complete' {durationMs, desyncCount} (INFO)
    - position balance should remain consistent (REST-fetched values match WS values)
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile call on reconnect)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (no WS reconnect behavior in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Reconcile logs store.reconcile.complete at INFO with durationMs + desyncCount.
    The existing timed monitor timer is NOT reset by reconnect — the armed timer
    continues to fire at the original exitAt.

- id: strategy_1.bybit.WEBSOCKET.FUNDING_FEE_EVENT_RECEIVED
  category: WEBSOCKET
  severity: medium
  description: >
    At T_f, Bybit emits an 'execution' topic event with execType='Funding' on the
    private WS. For strategy_1, this event is parsed by parseBybitMessage as a
    FundingFeeEvent and emitted as ws.funding_fee on the bus. The monitor is armed
    with exitPolicy.kind='timed' (not funding_fee_event), so this event has no effect
    on the exit trigger. The intent continues in monitoring until the timed exit fires
    at T_f + 2s.
  preconditions:
    - intent in status=monitoring
    - funding settlement occurs at T_f
  trigger_sequence:
    - Bybit WS: topic='execution' {execType: "Funding", symbol: <symbol>}
  expected_behavior:
    - ws.funding_fee bus event emitted (no log — only bus)
    - monitor does NOT settle on this event (it listens only for funding_fee_event policies)
    - intent stays in monitoring
    - timed exit fires 2s later
  observability_contract:
    - bus: 'ws.funding_fee' {exchange: "bybit", symbol: <symbol>} (no log for this event)
    - db:fundingAttributions row inserted for the funding fee credit
    - log: 'monitor.settle' {reason: "timed"} fires ~2s after this event
    - NO 'monitor.settle' {reason: "funding_fee"} emitted
  code_refs:
    - src/execution/adapters/privatews/bybit-mapping.ts:143 (topic='execution' handler)
    - src/execution/adapters/privatews/bybit-mapping.ts:151 (execType='Funding' check)
    - src/execution/execution/monitor.ts:97 (timed arm — funding_fee_event branch NOT entered)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (no explicit funding-fee event handling)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Bybit funding fee arrives on 'execution' topic with execType='Funding' (capital F).
    The execTime field is in MICROSECONDS — the mapping does NOT divide it here (it is
    stored as fundingTime directly from parseInt). Distinct from order fills which use
    execType='Trade'. For strategy_1 the funding fee event is informational only;
    the timed exit is what drives closure.

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_1.bybit.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process is restarted while a strategy_1 intent is in status=monitoring (entry
    filled, timed exit pending). Recovery rehydrates the IntentState from DB, restores
    byEntryOrderId and byCloseOrderId maps. manager.start() re-arms the monitor timer
    for all intents in monitoring state. Timed exit fires at the original exitAt.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=timed, exitAt in the future
    - entry order row exists (kind=entry, status=filled)
  trigger_sequence:
    - process restart
    - runRecovery() called
    - manager.start() calls monitor.arm(s) for all monitoring intents
  expected_behavior:
    - recovery: rehydrated intent states logged (rehydratedCount ≥ 1)
    - monitor.armed.timed logged (delay = exitAt - now, may be shorter than original)
    - timed exit fires and close order placed
    - intent exits normally
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: "≥1"}
    - log: 'monitor.armed.timed' {delay: "≥0"}
    - log: 'intent.exiting.start' {reason: "timed"}
    - log: 'order.placed' {kind: "timed"}
  code_refs:
    - src/execution/recovery/index.ts:87 (runRecovery)
    - src/execution/recovery/index.ts:140 (loadActiveIntents)
    - src/execution/recovery/index.ts:245 (rehydrated intent states log)
    - src/execution/execution/manager.ts:1888 (start — re-arm monitoring intents)
    - src/execution/execution/manager.ts:1892 (monitor.arm for status=monitoring)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (no recovery in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    If exitAt is in the past when recovery runs, delay=0 so the timer fires immediately.
    The position may still be open on the exchange — the close order must still be placed.
    Critical: if the monitoring intent is NOT found in DB (durability write failed), the
    timed exit will never fire → orphan position.

- id: strategy_1.bybit.RECOVERY.RESTART_ORPHAN_CANCEL
  category: RECOVERY
  severity: high
  description: >
    Process is restarted. A strategy_1 entry order was placed but the process crashed
    before the WS fill arrived. The order is open on Bybit but is NOT in the DB
    (durability write failed or crash before beforeCreateOrder completed). Recovery
    sees this as an orphan open order and cancels it.
  preconditions:
    - Bybit has an open entry order (not in DB rehydrated set)
  trigger_sequence:
    - runRecovery: getOpenOrders returns order not in rehydratedClientOrderIds
  expected_behavior:
    - 'recovery: orphan order found, cancelling' logged
    - cancelOrder called for the orphan
    - orphansCancelled counter incremented
  observability_contract:
    - log: 'recovery: orphan order found, cancelling' {exchange: "bybit", clientOrderId: <id>}
    - db:opsEvents {eventType: "recovery.orphan_order_cancelled"} (if emitted)
    - Bybit order eventually cancelled (verify via exchange UI or REST)
  code_refs:
    - src/execution/recovery/index.ts:271 (orphan order cancel loop)
    - src/execution/recovery/index.ts:273 (orphan cancel log)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (no recovery in spec)
  status: ⏳
  natural_occurrence: rare
  notes: >
    The durability write (beforeCreateOrder at manager.ts:2667) runs before createOrder.
    If the write succeeds but the process crashes before adding to byEntryOrderId,
    the order IS in the DB and will be rehydrated correctly. This scenario applies
    only when the durability write itself fails or the process dies before beforeCreateOrder.
    Bybit numeric error 110001 (order not found) may appear if the orphan order already
    expired by the time cancelOrder is called — treat as success.

# ── STRATEGY_SPECIFIC ────────────────────────────────────────────────────────

- id: strategy_1.bybit.STRATEGY_SPECIFIC.LEVERAGE_SET_ONCE
  category: STRATEGY_SPECIFIC
  severity: medium
  description: >
    setLeverage is called once per (exchange, symbol, leverage) triple. Subsequent
    strategy_1 intents on the same symbol use the cached result without additional
    REST calls. The leverageSet cache persists for the process lifetime.
  preconditions:
    - first intent on a given symbol
  trigger_sequence:
    - manager.submit() for symbol X, first time
    - manager.submit() for symbol X, second time (same leverage)
  expected_behavior:
    - first submit: setLeverage REST call made; no error
    - second submit: setLeverage skipped (cache hit); no REST call
    - both intents proceed normally
  observability_contract:
    - no duplicate setLeverage calls logged for the same (exchange, symbol, leverage) key
    - db:orders for second intent shows no delay between created and placed timestamps
  code_refs:
    - src/execution/execution/manager.ts:134 (ensureLeverage)
    - src/execution/execution/manager.ts:118 (leverageSet cache)
    - src/execution/execution/manager.ts:2067 (ensureLeverage call in submit)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (leverage parameter)
  status: ⏳
  natural_occurrence: routine
  notes: >
    If Bybit rejects setLeverage (e.g. leverage too high for the market's maxLeverage),
    the intent errors with code=set_leverage_failed before any order is placed.

- id: strategy_1.bybit.STRATEGY_SPECIFIC.NEGATIVE_FUNDING_THRESHOLD_FILTER
  category: STRATEGY_SPECIFIC
  severity: medium
  description: >
    strategy_1.evaluate() filters intents by fundingRatePercent < -negativeFundingThresholdPercent
    (config default 0.4%). If the funding rate is positive or less negative than the threshold,
    evaluate() returns an empty array and no intent is submitted.
  preconditions:
    - fundingRatePercent >= -0.4% (below threshold or positive)
  trigger_sequence:
    - scheduler fires evaluate() with a funding event that does not meet the condition
  expected_behavior:
    - strategy_1.evaluate() returns []
    - no intent.created log
    - no order placed
  observability_contract:
    - db:trade_intents no row for this symbol/timestamp
    - no log: 'intent.created' for this symbol/funding event
  code_refs:
    - src/execution/strategies/strategy_1.ts:21 (fundingRatePercent threshold check)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (Selection Logic — F_threshold = 0.4%)
  status: ⏳
  natural_occurrence: routine
  notes: >
    This is the most common case — most funding events won't meet the threshold.
    The absence of intent.created is the verification signal (negative verification).

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_1.bybit.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch is active (mode != 'off') when a strategy_1 intent would otherwise
    be submitted. Preflight rejects the intent with code=kill_switch before any
    REST call to the exchange. The spec has no mention of a kill switch.
  preconditions:
    - kill switch mode != 'off'
    - strategy_1 condition met (funding threshold, balance, etc.)
  trigger_sequence:
    - manager.submit() → preflight → killSwitch.canPlaceOrder() returns false
  expected_behavior:
    - intent.created logged (decided status)
    - intent.error logged with code=kill_switch
    - no order.placed
  observability_contract:
    - log: 'intent.error' {code: "kill_switch"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:intentLifecycleEvents decided→error
    - db:orders no entry for this intentId
  code_refs:
    - src/execution/execution/preflight.ts:32 (kill switch check)
    - src/execution/risk/kill-switch.ts (KillSwitch implementation)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (no kill switch mentioned)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Undocumented behavior — code has it, spec does not. Important for go-live:
    the kill switch is the emergency stop for all strategies.

- id: strategy_1.bybit.SPEC_DIVERGENCE.NO_REF_PRICE_EARLY_REJECT
  category: SPEC_DIVERGENCE
  severity: medium
  description: >
    manager.submit() checks refPrice(exchange, symbol) before preflight. If no ref
    price is available (price feed stale), the intent is immediately rejected with
    code=no_ref_price without reaching the exchange. The spec says "BUY MARKET at
    best ask" but implies a price is always available.
  preconditions:
    - refPrice returns undefined for the symbol at submit time
  trigger_sequence:
    - manager.submit() → refPrice check returns undefined
  expected_behavior:
    - intent.created logged
    - intent.error logged with code=no_ref_price
    - no order.placed
  observability_contract:
    - log: 'intent.error' {code: "no_ref_price"}
    - db:intentLifecycleEvents decided→error
  code_refs:
    - src/execution/execution/manager.ts:2012 (price undefined check)
    - src/execution/execution/manager.ts:2013 (setError no_ref_price)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (BUY MARKET at best ask — assumes price available)
  status: ⏳
  natural_occurrence: rare
  notes: >
    Undocumented behavior. Would occur if the price feed WebSocket is disconnected and
    no cached price is available at the moment of submission. Rare in normal operation
    since the WS price feed is typically more reliable than the funding WS.
```
