# Checklist — binance / strategy_1_ws

Exchange: **binance**
Strategy: **strategy_1_ws** (Negative Funding LONG — Funding-Fee Event Exit)
Spec: `docs-strategy/strategies/strategy_1_ws.md`
Code: `src/execution/strategies/strategy_1_ws.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/binance.ts`

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_1_ws.binance.ORDER_LIFECYCLE.ENTRY_PLACED_VIA_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - entryOffsetSeconds (default 5s). Preflight passes.
    setLeverage succeeds. orderClient() resolves to the WS order adapter (because
    requiresWsOrderAdapter('strategy_1_ws')=true). A market BUY is placed via the
    WS adapter. order.placed is logged with kind=entry, side=buy, orderType=market,
    reduceOnly=false, and a valid exchangeOrderId echoed back by Binance.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent (default -0.4%)
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - market status = trading
    - WS order adapter connected for binance
  trigger_sequence:
    - scheduler: evaluator fires at entryAt = nextFundingTimestamp - entryOffsetSeconds*1000
    - manager.submit() called with strategy_1_ws TradeIntent
  expected_behavior:
    - intent.created logged (strategy=strategy_1_ws, exchange=binance)
    - intent.submitted logged (entryKind=market)
    - WS adapter createOrder called (NOT REST)
    - order.placed logged (kind=entry, side=buy, orderType=market, reduceOnly=false)
    - status transitions decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_1_ws", exchange: "binance"}
    - log: 'intent.submitted' {entryKind: "market"}
    - log: 'order.placed' {kind: "entry", side: "buy", orderType: "market", reduceOnly: false}
    - db:orders row {kind: "entry", orderType: "market", reduceOnly: false, status: "pending"}
    - db:intentLifecycleEvents transitions decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:90 (requiresWsOrderAdapter — returns true for strategy_1_ws)
    - src/execution/execution/manager.ts:96 (orderClient — returns WS adapter, throws if missing)
    - src/execution/execution/manager.ts:2008 (intent.created log)
    - src/execution/execution/manager.ts:2095 (intent.submitted log)
    - src/execution/execution/manager.ts:2755 (order.placed log)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (Entry: WS order adapter required)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Binance WS order adapter sends the createOrder request over the websocket API.
    The clientOrderId is registered in byEntryOrderId before the WS call so any
    concurrent WS fill arriving during the call is not lost.

- id: strategy_1_ws.binance.ORDER_LIFECYCLE.ENTRY_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Entry market order fills. Binance emits ORDER_TRADE_UPDATE on the user data
    stream with X=FILLED. Manager routes via byEntryOrderId lookup using clientOrderId
    in field 'c'. Logs order.filled, transitions to filled, calls handleEntryFilled
    which emits position.opened and arms the funding_fee_event monitor.
  preconditions:
    - entry order placed (status=working)
    - Binance private WS connected
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {e: "ORDER_TRADE_UPDATE", E: <ms>, o: {X: "FILLED", c: <clientOrderId>, s: <symbol>}}
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice present)
    - status transitions working → filled → monitoring
    - position.opened logged (side=long, filledQty > 0)
    - monitor.armed.funding_fee_event logged (debug) with timeoutDelay and fundingTs
    - no SL/TP orders placed
  observability_contract:
    - log: 'order.filled' {exchange: "binance", filledQty: ">0"}
    - log: 'position.opened' {side: "long", filledQty: ">0"}
    - log: 'monitor.armed.funding_fee_event' {timeoutDelay, fundingTs}  # debug level
    - db:orders row {kind: "entry", status: "filled", filledQty: ">0"}
    - db:intentLifecycleEvents transition filled→monitoring
    - db:fills row for entry fill
  code_refs:
    - src/execution/adapters/privatews/binance.ts:48 (ORDER_TRADE_UPDATE parser — clientOrderId in o.c)
    - src/execution/adapters/privatews/mapping.ts:84 (mapOrderTradeUpdate)
    - src/execution/execution/manager.ts:1156 (order.filled log)
    - src/execution/execution/manager.ts:782 (position.opened log)
    - src/execution/execution/monitor.ts:210 (monitor.armed.funding_fee_event debug log)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (Entry fill → arm funding_fee_event monitor)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Binance uses clientOrderId in field 'c' of ORDER_TRADE_UPDATE. The monitor arms
    BOTH a timeout timer (at timeoutAt = nextFundingTimestamp + fundingFeeTimeoutSeconds*1000)
    and a bus listener on 'ws.funding_fee' with ±5s tolerance on fundingTs.

- id: strategy_1_ws.binance.ORDER_LIFECYCLE.ENTRY_PARTIAL_THEN_FULL_FILL
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Entry market order partially fills then fills fully. Manager logs intermediate
    partially_filled state, then fill completes and monitor arms normally.
  preconditions:
    - entry order in status=working
    - Binance emits PARTIALLY_FILLED then FILLED ORDER_TRADE_UPDATE events
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {o: {X: "PARTIALLY_FILLED"}}
    - Binance WS: ORDER_TRADE_UPDATE {o: {X: "FILLED"}}
  expected_behavior:
    - status transitions working → partially_filled (on partial)
    - status transitions partially_filled → filled (on full fill)
    - order.filled logged once on FILLED event
    - position.opened logged
    - monitor armed (funding_fee_event)
  observability_contract:
    - db:intentLifecycleEvents transition working→partially_filled then partially_filled→filled
    - log: 'order.filled' {filledQty: "total qty"} (emitted on FILLED, not on PARTIALLY_FILLED)
    - log: 'position.opened' {side: "long"}
    - log: 'monitor.armed.funding_fee_event' {fundingTs}
  code_refs:
    - src/execution/execution/manager.ts:1159 (partially_filled transition)
    - src/execution/execution/manager.ts:1156 (FILLED branch order.filled)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Market orders on Binance rarely produce partial fills but can in thin markets.
    handleEntryFilled is called only on the final FILLED event.

- id: strategy_1_ws.binance.ORDER_LIFECYCLE.ENTRY_WS_ADAPTER_MISSING
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    orderClient() is called but no WS order adapter is registered for binance.
    requiresWsOrderAdapter('strategy_1_ws')=true, so the function throws immediately
    rather than falling back to REST. Intent transitions to error.
  preconditions:
    - strategy_1_ws intent submitted
    - opts.orderWsAdapters has no entry for 'binance'
  trigger_sequence:
    - manager.submit() → orderClient('binance', 'strategy_1_ws') throws
  expected_behavior:
    - intent.error logged with code indicating missing adapter
    - no order.placed log
    - status transitions to error (terminal)
  observability_contract:
    - log: 'intent.error' {code: "no_adapter" or thrown error message}
    - db:intentLifecycleEvents →error
    - db:orders no entry for this intentId
  code_refs:
    - src/execution/execution/manager.ts:97 (requiresWsOrderAdapter check)
    - src/execution/execution/manager.ts:100 (throws if WS adapter missing)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (requiresWsOrderAdapter=true)
  status: ⏳
  natural_occurrence: rare
  notes: >
    This is a configuration error — the WS adapter must be registered for binance
    before strategy_1_ws intents are submitted. No REST fallback for entry placement.

- id: strategy_1_ws.binance.ORDER_LIFECYCLE.CLOSE_WS_REJECTED_REST_FALLBACK
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Monitor exit fires (funding_fee or funding_fee_timeout). handleMonitorExit places
    a market SELL reduce-only close via WS adapter. The WS adapter returns status=rejected.
    Because requiresWsOrderAdapter=true, manager logs close.ws_rejected and immediately
    retries via REST createOrder. The REST order succeeds and is tracked normally.
  preconditions:
    - intent in status=monitoring
    - funding_fee_event triggered exit
    - WS adapter returns rejected ACK for close order
  trigger_sequence:
    - monitor.settle → handleMonitorExit
    - WS adapter createOrder returns {status: 'rejected'}
    - REST createOrder called as fallback
  expected_behavior:
    - close.ws_rejected logged (error level) with rejectReason
    - REST fallback createOrder called
    - order.placed logged (kind=close, side=sell, orderType=market, reduceOnly=true)
    - close fill detected via WS or REST poll
    - intent transitions to exited
  observability_contract:
    - log: 'close.ws_rejected' {rejectReason}  # error level
    - log: 'order.placed' {kind: "close", side: "sell", orderType: "market", reduceOnly: true}
    - db:orders {kind: "close", status: "filled"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/manager.ts:1620 (ws_rejected check)
    - src/execution/execution/manager.ts:1622 (close.ws_rejected log)
    - src/execution/execution/manager.ts:1625 (REST fallback createOrder)
    - src/execution/execution/manager.ts:1660 (order.placed log)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (REST fallback if WS close rejected)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Note kind='close' (not 'timed') because reason is funding_fee or funding_fee_timeout.
    closeKind = reason === 'timed' ? 'timed' : 'close' (manager.ts:1585).

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_1_ws.binance.TIMING.ENTRY_AT_CORRECT_OFFSET
  category: TIMING
  severity: high
  description: >
    Entry is placed at approximately T_f - 5s (entryOffsetSeconds). The elapsed time
    from entryAt to order.placed should be within a few hundred ms (WS call latency
    + setLeverage). WS placement is typically faster than REST.
  preconditions:
    - scheduler running and synced to exchange clock
    - strategy condition met
  trigger_sequence:
    - scheduler: fires evaluate() at entryAt = nextFundingTimestamp - entryOffsetSeconds*1000
  expected_behavior:
    - intent.submitted timestamp within ≤1000ms after entryAt
    - order.placed (kind=entry) timestamp within ≤1500ms after entryAt
  observability_contract:
    - log: 'intent.submitted' timestamp ≤ entryAt + 1000ms
    - log: 'order.placed' {kind: "entry"} timestamp ≤ entryAt + 1500ms
    - db:orders {kind: "entry"} createdAt within [entryAt, entryAt + 1500ms]
  code_refs:
    - src/execution/strategies/strategy_1_ws.ts:51 (entryAt = nextFundingTimestamp - entryOffsetSeconds*1000)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (Entry offset T_entry = T_funding − 5s)
  status: ⏳
  natural_occurrence: routine
  notes: >
    WS order placement is lower latency than REST but still subject to exchange round-trip.

- id: strategy_1_ws.binance.TIMING.FUNDING_FEE_EVENT_EXIT
  category: TIMING
  severity: critical
  description: >
    At T_f, Binance emits ACCOUNT_UPDATE with a.m=FUNDING_FEE on the private WS.
    The adapter maps this to a FundingFeeEvent (symbol from a.P[0].s, fundingTime from T).
    The monitor bus listener checks exchange, symbol, and |fundingTime - fundingTs| <= 5000ms.
    Match triggers settle('funding_fee', {source:'ws', latencyMs}). Manager places
    market close (kind=close).
  preconditions:
    - intent in status=monitoring
    - monitor armed with funding_fee_event policy
    - Binance emits ACCOUNT_UPDATE with m=FUNDING_FEE at T_f
  trigger_sequence:
    - Binance WS: ACCOUNT_UPDATE {e: "ACCOUNT_UPDATE", E: <ms>, T: <ms>, a: {m: "FUNDING_FEE", P: [{s: <symbol>}], B: [...]}}
    - bus: 'ws.funding_fee' emitted
    - monitor listener matches → settle('funding_fee', {source: 'ws'})
  expected_behavior:
    - monitor.exit_requested logged (reason=funding_fee)
    - monitor.settle logged (reason=funding_fee, source=ws, latencyMs measurable)
    - intent.exiting.start logged (reason=funding_fee)
    - order.placed (kind=close, side=sell, reduceOnly=true)
    - intent exits normally
  observability_contract:
    - log: 'monitor.exit_requested' {reason: "funding_fee"}
    - log: 'monitor.settle' {reason: "funding_fee", source: "ws", latencyMs: "<5000"}
    - log: 'intent.exiting.start' {reason: "funding_fee"}
    - log: 'order.placed' {kind: "close", side: "sell", orderType: "market", reduceOnly: true}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/adapters/privatews/binance.ts:52 (ACCOUNT_UPDATE handler)
    - src/execution/adapters/privatews/mapping.ts:154 (mapFundingFee — m=FUNDING_FEE check, symbol from a.P[0].s, fundingTime from T)
    - src/execution/execution/monitor.ts:198 (bus.on 'ws.funding_fee' listener)
    - src/execution/execution/monitor.ts:200 (tolerance check ±5000ms)
    - src/execution/execution/monitor.ts:47 (monitor.exit_requested log)
    - src/execution/execution/monitor.ts:93 (monitor.settle log)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (Exit: ws.funding_fee within ±5s of fundingTs)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Binance ACCOUNT_UPDATE with m=FUNDING_FEE: fundingTime comes from raw.T (transaction time ms),
    symbol from raw.a.P[0].s. The mapping.ts mapFundingFee returns null if m != FUNDING_FEE
    or if P[0]/B[0] are absent.

- id: strategy_1_ws.binance.TIMING.FUNDING_FEE_TIMEOUT
  category: TIMING
  severity: high
  description: >
    ws.funding_fee event does not arrive within fundingFeeTimeoutSeconds after T_f.
    The timeout timer (set at monitor arm time) fires and calls settle('funding_fee_timeout',
    {source:'timer'}). Manager places market close with reason=funding_fee_timeout.
  preconditions:
    - intent in status=monitoring
    - ws.funding_fee not received before timeoutAt
  trigger_sequence:
    - setTimeout callback fires at timeoutAt = nextFundingTimestamp + fundingFeeTimeoutSeconds*1000
  expected_behavior:
    - monitor.settle logged (reason=funding_fee_timeout, source=timer, latencyMs measurable)
    - intent.exiting.start logged (reason=funding_fee_timeout)
    - order.placed (kind=close, side=sell, reduceOnly=true)
    - intent exits normally
  observability_contract:
    - log: 'monitor.settle' {reason: "funding_fee_timeout", source: "timer"}
    - log: 'intent.exiting.start' {reason: "funding_fee_timeout"}
    - log: 'order.placed' {kind: "close", side: "sell", orderType: "market", reduceOnly: true}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:188 (timeout timer setup)
    - src/execution/execution/monitor.ts:190 (settle funding_fee_timeout)
    - src/execution/execution/manager.ts:1487 (intent.exiting.start log)
    - src/execution/execution/manager.ts:1585 (closeKind='close' for funding_fee_timeout)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (Timeout fallback)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Normal operation — WS is usually fast but network delays can cause timeouts.
    The timeout is the safety net ensuring position is closed even if the WS event is missed.

- id: strategy_1_ws.binance.TIMING.ENTRY_FILL_REST_POLL_FALLBACK
  category: TIMING
  severity: high
  description: >
    WS ORDER_TRADE_UPDATE fill event for the entry order does not arrive (brief WS gap).
    The REST poll fallback (pollForEntryFill, 15 polls × 1s) detects the fill via
    getOrder and drives the intent to filled → monitoring.
  preconditions:
    - entry order placed (status=working)
    - WS fill event not received within poll window
  trigger_sequence:
    - pollForEntryFill loop: getOrder returns status=filled
  expected_behavior:
    - order.filled logged (from poll path)
    - status transitions working → filled → monitoring
    - position.opened logged
    - monitor armed (funding_fee_event)
  observability_contract:
    - log: 'order.filled' (from poll, not WS)
    - log: 'position.opened'
    - db:intentLifecycleEvents working→filled→monitoring
    - no prior 'order.filled' log (WS would have emitted it earlier)
  code_refs:
    - src/execution/execution/manager.ts:1179 (pollForEntryFill)
    - src/execution/execution/manager.ts:2787 (poll started after REST ack)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    On Binance, WS fill events are reliable for market orders. The poll fallback is a
    safety net. Both WS and poll paths are idempotent (TERMINAL guard).

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_1_ws.binance.WEBSOCKET.RECONNECT_TRIGGERS_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    Binance private WS disconnects and reconnects while intent is in monitoring.
    The state store listener detects ws.connection transition to 'connected' and
    calls store.reconcile(). reconcile() fetches open orders and positions from REST,
    updating in-memory state. The funding_fee_event monitor remains armed — it is not
    re-armed by reconnect.
  preconditions:
    - intent in status=monitoring
    - WS disconnects then reconnects
  trigger_sequence:
    - ws.connection event: {state: "disconnected"}
    - ws.connection event: {state: "connected"}
  expected_behavior:
    - store.reconcile() called → REST getOpenOrders + getPositions fetched
    - state maps updated
    - monitor NOT re-armed (existing timer and bus listener remain active)
    - no duplicate exit triggered
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal bus — no logger.info)
    - log: event='ws.connection' {exchange: "binance", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - position balance remains consistent (REST values match WS values)
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile call on reconnect)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Reconcile logs store.reconcile.complete at INFO. The ws.funding_fee bus listener created at monitor arm time remains
    active through reconnects — it will catch the event when the WS reconnects before T_f.

- id: strategy_1_ws.binance.WEBSOCKET.FUNDING_FEE_WRONG_SYMBOL_IGNORED
  category: WEBSOCKET
  severity: medium
  description: >
    Binance emits ACCOUNT_UPDATE with m=FUNDING_FEE for a different symbol at T_f.
    The monitor bus listener receives ws.funding_fee but filters out by symbol mismatch
    (event.symbol !== intent.symbol). The intent remains in monitoring until the correct
    event arrives or the timeout fires.
  preconditions:
    - intent in status=monitoring for symbol X
    - Binance emits ACCOUNT_UPDATE for symbol Y (different from X)
  trigger_sequence:
    - Binance WS: ACCOUNT_UPDATE {a: {m: "FUNDING_FEE", P: [{s: <symbolY>}]}}
    - bus: 'ws.funding_fee' {symbol: symbolY}
    - monitor listener: event.symbol !== intent.symbol → ignored
  expected_behavior:
    - monitor does NOT settle
    - intent stays in monitoring
    - timeout timer still active
  observability_contract:
    - NO 'monitor.settle' log for this event
    - intent status remains 'monitoring' in db
    - NO 'intent.exiting.start' log
  code_refs:
    - src/execution/execution/monitor.ts:199 (symbol filter: if event.symbol !== intent.symbol return)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (symbol filter in monitor)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Also applies to timestamp mismatch: if |event.fundingTime - fundingTs| > 5000ms,
    the event is ignored (monitor.ts:201). Both filters must pass for settle to fire.

- id: strategy_1_ws.binance.WEBSOCKET.CLOSE_WS_REJECTED_REST_FALLBACK
  category: WEBSOCKET
  severity: high
  description: >
    Same as ORDER_LIFECYCLE.CLOSE_WS_REJECTED_REST_FALLBACK — documented here for
    WS-category completeness. WS adapter rejects close order; REST fallback executes.
    See that scenario for full detail.
  preconditions:
    - intent in status=exiting
    - WS adapter rejects close order
  trigger_sequence:
    - WS adapter createOrder → {status: 'rejected'}
    - manager: close.ws_rejected → REST fallback
  expected_behavior:
    - close.ws_rejected logged
    - REST close placed successfully
  observability_contract:
    - log: 'close.ws_rejected' {rejectReason}
    - log: 'order.placed' {kind: "close"}
  code_refs:
    - src/execution/execution/manager.ts:1620 (ws_rejected check)
    - src/execution/execution/manager.ts:1622 (close.ws_rejected log)
    - src/execution/execution/manager.ts:1625 (REST fallback)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_1_ws.binance.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process is restarted while a strategy_1_ws intent is in status=monitoring (entry
    filled, funding_fee_event exit pending). Recovery rehydrates IntentState from DB.
    manager.start() re-arms the monitor for all monitoring intents. The monitor re-arms
    with funding_fee_event policy: new timeout timer (delay = max(0, timeoutAt - now))
    and new bus listener on ws.funding_fee.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=funding_fee_event, timeoutAt in the future or past
    - entry order row exists (kind=entry, status=filled)
  trigger_sequence:
    - process restart
    - runRecovery() called
    - manager.start() calls monitor.arm() for all monitoring intents
  expected_behavior:
    - recovery: rehydrated intent states logged (rehydratedCount >= 1)
    - monitor.armed.funding_fee_event logged (debug) with new timeoutDelay and fundingTs
    - if ws.funding_fee arrives → settle funding_fee
    - if timeoutAt already past → timer fires immediately (delay=0)
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.funding_fee_event' {timeoutDelay: ">=0", fundingTs}
    - log: 'intent.exiting.start' {reason: "funding_fee" or "funding_fee_timeout"}
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated intent states log)
    - src/execution/execution/manager.ts:1888 (start — re-arm monitoring intents)
    - src/execution/execution/monitor.ts:183 (funding_fee_event arm branch)
    - src/execution/execution/monitor.ts:188 (timeout timer with max(0, timeoutAt - now))
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    If timeoutAt is already in the past when recovery runs, delay=0 and the timer fires
    immediately. The position is still open on the exchange — the close order is placed
    as funding_fee_timeout. The ws.funding_fee listener is also re-created but the event
    will not arrive again (funding already settled), so timeout path is taken.

- id: strategy_1_ws.binance.RECOVERY.RESTART_TIMEOUT_ALREADY_PAST
  category: RECOVERY
  severity: high
  description: >
    Process restarts after T_f + fundingFeeTimeoutSeconds has elapsed. The monitor
    re-arms with timeoutDelay=0 (max(0, timeoutAt - now - skewMs) = 0). Timer fires
    immediately, settle('funding_fee_timeout') runs, close order placed right away.
  preconditions:
    - intent in DB with status=monitoring
    - now > timeoutAt at recovery time
  trigger_sequence:
    - runRecovery → monitor.arm → timeoutDelay=0 → timer fires synchronously
  expected_behavior:
    - monitor.armed.funding_fee_event logged with timeoutDelay=0
    - monitor.settle logged (reason=funding_fee_timeout, source=timer)
    - intent.exiting.start logged immediately
    - close order placed
  observability_contract:
    - log: 'monitor.armed.funding_fee_event' {timeoutDelay: 0}
    - log: 'monitor.settle' {reason: "funding_fee_timeout", source: "timer"}
    - log: 'intent.exiting.start' {reason: "funding_fee_timeout"}
  code_refs:
    - src/execution/execution/monitor.ts:188 (timeoutDelay = Math.max(0, timeoutAt - now - skewMs))
    - src/execution/execution/monitor.ts:190 (settle funding_fee_timeout)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

# ── STRATEGY_SPECIFIC ────────────────────────────────────────────────────────

- id: strategy_1_ws.binance.STRATEGY_SPECIFIC.WS_ADAPTER_REQUIRED_NO_REST_FALLBACK_FOR_ENTRY
  category: STRATEGY_SPECIFIC
  severity: critical
  description: >
    strategy_1_ws always uses the WS order adapter for entry. If the adapter is
    present but the WS order fails at the network layer (not a rejected ACK — a throw),
    the error propagates and the intent enters error state. There is NO REST fallback
    for entry placement (unlike the close order which has a REST fallback for ws_rejected).
  preconditions:
    - opts.orderWsAdapters has a binance WS adapter registered
    - WS adapter createOrder throws (not returns rejected)
  trigger_sequence:
    - orderClient('binance', 'strategy_1_ws') returns WS adapter
    - WS adapter createOrder() throws
    - catch block in manager → setError(s, 'create_order_failed', ...)
  expected_behavior:
    - intent.error logged
    - no REST fallback for entry
    - status → error (terminal)
  observability_contract:
    - log: 'intent.error' {code: "create_order_failed"}
    - db:intentLifecycleEvents →error
  code_refs:
    - src/execution/execution/manager.ts:90 (requiresWsOrderAdapter)
    - src/execution/execution/manager.ts:97 (orderClient returns WS adapter)
    - src/execution/execution/manager.ts:100 (throws if missing)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: rare
  notes: >
    The REST fallback exists only for close (line 1625): when WS returns rejected ACK.
    Entry has no such fallback — a thrown error or rejected entry ACK leads to error state.

- id: strategy_1_ws.binance.STRATEGY_SPECIFIC.FUNDING_FEE_EVENT_MATCHED_CORRECTLY
  category: STRATEGY_SPECIFIC
  severity: critical
  description: >
    Monitor matches ws.funding_fee only when exchange, symbol, AND fundingTime are all
    correct. Exchange filter prevents cross-exchange confusion. Symbol filter prevents
    same-exchange multi-symbol confusion. Timestamp filter (±5000ms) prevents stale events.
  preconditions:
    - intent in monitoring for (binance, symbolX, fundingTs=T)
  trigger_sequence:
    - bus: 'ws.funding_fee' {exchange: "binance", symbol: "symbolX", fundingTime: T ± 3000ms}
  expected_behavior:
    - monitor listener: exchange matches, symbol matches, timestamp within tolerance → settle
    - settle('funding_fee', {source: 'ws', latencyMs: receivedAt - fundingTime})
  observability_contract:
    - log: 'monitor.settle' {reason: "funding_fee", source: "ws", latencyMs: "<5000"}
  code_refs:
    - src/execution/execution/monitor.ts:199 (exchange filter)
    - src/execution/execution/monitor.ts:200 (symbol filter)
    - src/execution/execution/monitor.ts:201 (timestamp tolerance ±5000ms)
    - src/execution/execution/monitor.ts:202 (settle 'funding_fee')
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (±5s tolerance on fundingTs)
  status: ⏳
  natural_occurrence: routine

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_1_ws.binance.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch is active (mode != 'off') when a strategy_1_ws intent would otherwise
    be submitted. Preflight rejects the intent with code=kill_switch before any order
    reaches the exchange.
  preconditions:
    - kill switch mode != 'off'
    - strategy_1_ws condition met
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
    - src/execution/execution/preflight.ts:32 (kill switch check)
    - src/execution/risk/kill-switch.ts (KillSwitch implementation)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (no kill switch mentioned)
  status: ⏳
  natural_occurrence: occasional

- id: strategy_1_ws.binance.SPEC_DIVERGENCE.NO_REF_PRICE_EARLY_REJECT
  category: SPEC_DIVERGENCE
  severity: medium
  description: >
    manager.submit() checks refPrice(exchange, symbol) before preflight. If no ref price
    is available (price feed stale), the intent is rejected with code=no_ref_price.
    strategy_1_ws.evaluate() also checks refPrice and returns [] if undefined — so this
    guard is a secondary safety net if the price disappears between evaluate() and submit().
  preconditions:
    - refPrice returns undefined at submit time
  trigger_sequence:
    - manager.submit() → price undefined → setError no_ref_price
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
    - src/execution/strategies/strategy_1_ws.ts:27 (evaluate() refPrice check)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: rare
```
