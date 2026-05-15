# Checklist — okx / strategy_1_ws

Exchange: **okx**
Strategy: **strategy_1_ws** (Negative Funding LONG — Funding-Fee Event Exit)
Spec: `docs-strategy/strategies/strategy_1_ws.md`
Code: `src/execution/strategies/strategy_1_ws.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/okx.ts`

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_1_ws.okx.ORDER_LIFECYCLE.ENTRY_PLACED_VIA_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - entryOffsetSeconds (default 5s). Preflight passes.
    setLeverage succeeds. orderClient() resolves to the WS order adapter
    (requiresWsOrderAdapter('strategy_1_ws')=true). A market BUY is placed via
    the WS adapter. canonicalize() strips dashes from the clientOrderId before
    registration (manager.ts:130). order.placed logged with kind=entry, side=buy,
    orderType=market, reduceOnly=false, and exchangeOrderId echoed back by OKX.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent (default -0.4%)
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - market status = trading
    - WS order adapter connected for okx
  trigger_sequence:
    - scheduler: evaluator fires at entryAt = nextFundingTimestamp - entryOffsetSeconds*1000
    - manager.submit() called with strategy_1_ws TradeIntent (exchange=okx)
  expected_behavior:
    - intent.created logged (strategy=strategy_1_ws, exchange=okx)
    - intent.submitted logged (entryKind=market)
    - WS adapter createOrder called (NOT REST)
    - clientOrderId has dashes stripped by canonicalize() before byEntryOrderId registration
    - order.placed logged (kind=entry, side=buy, orderType=market, reduceOnly=false)
    - status transitions decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_1_ws", exchange: "okx"}
    - log: 'intent.submitted' {entryKind: "market"}
    - log: 'order.placed' {kind: "entry", side: "buy", orderType: "market", reduceOnly: false}
    - db:orders row {kind: "entry", orderType: "market", reduceOnly: false, status: "pending"}
    - db:intentLifecycleEvents transitions decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:130 (canonicalize — strips dashes for OKX)
    - src/execution/execution/manager.ts:90 (requiresWsOrderAdapter — true for strategy_1_ws)
    - src/execution/execution/manager.ts:96 (orderClient — returns WS adapter)
    - src/execution/execution/manager.ts:2008 (intent.created log)
    - src/execution/execution/manager.ts:2095 (intent.submitted log)
    - src/execution/execution/manager.ts:2755 (order.placed log)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (Entry: WS order adapter required)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX strips dashes from clientOrderId via canonicalize(). The stripped ID is used
    as the key in byEntryOrderId. OKX WS order fills arrive on the 'orders' channel
    (not ORDER_TRADE_UPDATE like Binance). clientOrderId in OKX fill events is the
    stripped form (no dashes).

- id: strategy_1_ws.okx.ORDER_LIFECYCLE.ENTRY_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Entry market order fills. OKX private WS emits on 'orders' channel with
    state=filled. The adapter maps it to an order fill event. Manager routes via
    byEntryOrderId lookup using the canonicalized (dash-stripped) clientOrderId.
    Logs order.filled, transitions to filled, calls handleEntryFilled which emits
    position.opened and arms the funding_fee_event monitor.
  preconditions:
    - entry order placed (status=working)
    - OKX private WS connected
  trigger_sequence:
    - OKX WS: 'orders' channel event {state: "filled", clOrdId: <stripped-clientOrderId>}
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice present)
    - status transitions working → filled → monitoring
    - position.opened logged (side=long, filledQty > 0)
    - monitor.armed.funding_fee_event logged (debug) with timeoutDelay and fundingTs
    - no SL/TP orders placed
  observability_contract:
    - log: 'order.filled' {exchange: "okx", filledQty: ">0"}
    - log: 'position.opened' {side: "long", filledQty: ">0"}
    - log: 'monitor.armed.funding_fee_event' {timeoutDelay, fundingTs}  # debug level
    - db:orders row {kind: "entry", status: "filled", filledQty: ">0"}
    - db:intentLifecycleEvents transition filled→monitoring
    - db:fills row for entry fill
  code_refs:
    - src/execution/adapters/privatews/okx.ts (orders channel handler)
    - src/execution/execution/manager.ts:130 (canonicalize — dash-strip for OKX)
    - src/execution/execution/manager.ts:1156 (order.filled log)
    - src/execution/execution/manager.ts:782 (position.opened log)
    - src/execution/execution/monitor.ts:210 (monitor.armed.funding_fee_event debug log)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (Entry fill → arm funding_fee_event monitor)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX 'orders' channel carries clOrdId (the dash-stripped clientOrderId). The
    canonical byEntryOrderId map key is also the dash-stripped form, so the lookup
    succeeds. OKX timestamps in fill events are milliseconds (no μs conversion needed).

- id: strategy_1_ws.okx.ORDER_LIFECYCLE.ENTRY_WS_ADAPTER_MISSING
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    orderClient() is called but no WS order adapter is registered for okx.
    requiresWsOrderAdapter('strategy_1_ws')=true, so the function throws immediately
    rather than falling back to REST. Intent transitions to error.
  preconditions:
    - strategy_1_ws intent submitted for okx
    - opts.orderWsAdapters has no entry for 'okx'
  trigger_sequence:
    - manager.submit() → orderClient('okx', 'strategy_1_ws') throws
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
    Configuration error — WS adapter must be registered for okx before
    strategy_1_ws intents are submitted. No REST fallback for entry.

- id: strategy_1_ws.okx.ORDER_LIFECYCLE.CLOSE_WS_REJECTED_REST_FALLBACK
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Monitor exit fires (funding_fee or funding_fee_timeout). handleMonitorExit places
    a market SELL reduce-only close via the WS adapter. The WS adapter returns
    status=rejected. Manager logs close.ws_rejected and immediately retries via
    REST createOrder. The REST order succeeds and is tracked normally.
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
    kind='close' because reason=funding_fee (not 'timed').
    closeKind = reason === 'timed' ? 'timed' : 'close' (manager.ts:1585).
    OKX rate limit code 50011 would surface here if REST fallback also rate-limited.

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_1_ws.okx.TIMING.ENTRY_AT_CORRECT_OFFSET
  category: TIMING
  severity: high
  description: >
    Entry is placed at approximately T_f - 5s (entryOffsetSeconds). Elapsed time
    from entryAt to order.placed should be within a few hundred ms (WS adapter
    round-trip + setLeverage). OKX WS order latency is typically <100ms.
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
    OKX WS placement is low latency. OKX timestamps are in milliseconds.

- id: strategy_1_ws.okx.TIMING.FUNDING_FEE_EVENT_EXIT
  category: TIMING
  severity: critical
  description: >
    At T_f, OKX emits on the 'account.bills' WS channel with bizType containing
    "FUND" (e.g., "Funding fee"). The OKX WS adapter maps this to a FundingFeeEvent
    (symbol, fundingTime extracted from the event). The monitor bus listener checks
    exchange, symbol, and |fundingTime - fundingTs| <= 5000ms. Match triggers
    settle('funding_fee', {source:'ws', latencyMs}). Manager places market close.
  preconditions:
    - intent in status=monitoring
    - monitor armed with funding_fee_event policy
    - OKX emits account.bills funding event at T_f
  trigger_sequence:
    - OKX WS: 'account.bills' event {bizType: "Funding fee", instId: <symbol>}
    - bus: 'ws.funding_fee' emitted by OKX adapter
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
    - src/execution/adapters/privatews/okx.ts (account.bills handler)
    - src/execution/execution/monitor.ts:198 (bus.on 'ws.funding_fee' listener)
    - src/execution/execution/monitor.ts:200 (tolerance check ±5000ms)
    - src/execution/execution/monitor.ts:47 (monitor.exit_requested log)
    - src/execution/execution/monitor.ts:93 (monitor.settle log)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (Exit: ws.funding_fee within ±5s of fundingTs)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX account.bills bizType for funding is typically "Funding fee" — exact string
    depends on OKX WS API version. Symbol in the event maps to the OKX instId format
    (e.g., BTC-USDT-SWAP) which adapter normalizes to match intent.symbol.
    OKX timestamps in bills events are in milliseconds.

- id: strategy_1_ws.okx.TIMING.FUNDING_FEE_TIMEOUT
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
    - monitor.settle logged (reason=funding_fee_timeout, source=timer)
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

- id: strategy_1_ws.okx.TIMING.ENTRY_FILL_REST_POLL_FALLBACK
  category: TIMING
  severity: high
  description: >
    OKX WS 'orders' fill event does not arrive (brief WS gap). The REST poll fallback
    (pollForEntryFill, 15 polls × 1s) detects the fill via getOrder and drives the
    intent to filled → monitoring.
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
  code_refs:
    - src/execution/execution/manager.ts:1179 (pollForEntryFill)
    - src/execution/execution/manager.ts:2787 (poll started after ACK)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    OKX WS 'orders' fill events are generally reliable. REST poll is safety net.
    Both paths are idempotent (TERMINAL guard prevents double-processing).

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_1_ws.okx.WEBSOCKET.RECONNECT_TRIGGERS_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    OKX private WS disconnects and reconnects while intent is in monitoring.
    The state store listener detects ws.connection transition to 'connected' and
    calls store.reconcile(). reconcile() fetches open orders and positions from REST.
    The funding_fee_event monitor remains armed through the reconnect.
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
    - log: event='ws.connection' {exchange: "okx", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - position balance remains consistent after reconcile
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile call on reconnect)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    OKX WS requires periodic token renewal (OKX login message). Reconnect after
    token expiry triggers reconcile. The ws.funding_fee bus listener created at
    monitor arm time survives reconnects and will catch the next event.

- id: strategy_1_ws.okx.WEBSOCKET.FUNDING_FEE_WRONG_SYMBOL_IGNORED
  category: WEBSOCKET
  severity: medium
  description: >
    OKX emits account.bills funding event for a different symbol at T_f.
    The monitor bus listener receives ws.funding_fee but filters by symbol mismatch.
    The intent remains in monitoring until the correct event arrives or timeout fires.
  preconditions:
    - intent in status=monitoring for symbol X
    - OKX emits account.bills funding event for symbol Y (different from X)
  trigger_sequence:
    - OKX WS: account.bills {instId: <symbolY>, bizType: "Funding fee"}
    - bus: 'ws.funding_fee' {symbol: symbolY}
    - monitor listener: event.symbol !== intent.symbol → ignored
  expected_behavior:
    - monitor does NOT settle
    - intent stays in monitoring
    - timeout timer still active
  observability_contract:
    - NO 'monitor.settle' log for this event
    - intent status remains 'monitoring' in db
  code_refs:
    - src/execution/execution/monitor.ts:199 (exchange filter)
    - src/execution/execution/monitor.ts:200 (symbol filter)
    - src/execution/execution/monitor.ts:201 (timestamp tolerance ±5000ms)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (symbol filter in monitor)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    OKX normalizes OKX instId (BTC-USDT-SWAP) to BTCUSDT before emitting ws.funding_fee.
    Symbol mismatch filtering prevents cross-symbol confusion.

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_1_ws.okx.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while a strategy_1_ws intent is in status=monitoring.
    Recovery rehydrates IntentState from DB. manager.start() re-arms the monitor
    for all monitoring intents. The monitor re-arms with funding_fee_event policy:
    new timeout timer (delay = max(0, timeoutAt - now)) and new ws.funding_fee listener.
    Recovery also applies canonicalize() to restore dash-stripped clientOrderId lookups.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=funding_fee_event, timeoutAt in future or past
  trigger_sequence:
    - process restart → runRecovery() → manager.start() re-arms monitoring intents
  expected_behavior:
    - 'recovery: rehydrated intent states' logged (rehydratedCount >= 1)
    - monitor.armed.funding_fee_event logged (debug) with new timeoutDelay and fundingTs
    - if timeoutAt already past: timer fires immediately (delay=0)
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.funding_fee_event' {timeoutDelay: ">=0", fundingTs}
  code_refs:
    - src/execution/recovery/index.ts:132 (canonicalize applied during recovery)
    - src/execution/recovery/index.ts:245 (rehydrated intent states log)
    - src/execution/execution/manager.ts:1888 (start — re-arm monitoring intents)
    - src/execution/execution/monitor.ts:183 (funding_fee_event arm branch)
    - src/execution/execution/monitor.ts:188 (timeout timer with max(0, timeoutAt - now))
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    OKX canonicalize() strips dashes from clientOrderId during recovery (recovery.ts:132).
    The rehydrated byEntryOrderId map uses the dash-stripped form for correct lookup
    when WS events arrive after recovery.

- id: strategy_1_ws.okx.RECOVERY.RESTART_TIMEOUT_ALREADY_PAST
  category: RECOVERY
  severity: high
  description: >
    Process restarts after T_f + fundingFeeTimeoutSeconds has elapsed. The monitor
    re-arms with timeoutDelay=0. Timer fires immediately, settle('funding_fee_timeout')
    runs, close order placed immediately. Position is still open on OKX.
  preconditions:
    - intent in DB with status=monitoring
    - now > timeoutAt at recovery time
  trigger_sequence:
    - runRecovery → monitor.arm → timeoutDelay=0 → timer fires synchronously
  expected_behavior:
    - monitor.armed.funding_fee_event logged with timeoutDelay=0
    - monitor.settle {reason: "funding_fee_timeout"} logged immediately
    - close order placed via REST or WS adapter
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

- id: strategy_1_ws.okx.STRATEGY_SPECIFIC.CLIENT_ORDER_ID_DASH_STRIP
  category: STRATEGY_SPECIFIC
  severity: critical
  description: >
    OKX rejects clientOrderIds containing dashes. canonicalize() at manager.ts:130
    strips dashes before registering the ID in byEntryOrderId and before placing the
    order via WS adapter. The stripped ID must match what OKX echoes back in 'orders'
    channel fill events. Recovery at index.ts:132 also applies canonicalize().
  preconditions:
    - strategy_1_ws intent submitted for okx
    - clientOrderId contains dashes (UUID format)
  trigger_sequence:
    - manager.submit() → canonicalize('okx', clientOrderId) → dash-stripped ID
    - byEntryOrderId.set(strippedId, intentId)
    - WS adapter sends strippedId to OKX
  expected_behavior:
    - OKX fill event clOrdId matches strippedId (no dashes)
    - byEntryOrderId lookup succeeds on fill event
    - no 'order not found in byEntryOrderId' errors
  observability_contract:
    - log: 'order.placed' shows clientOrderId without dashes
    - db:orders clientOrderId column: dash-free string
    - no unmatched fill events in logs
  code_refs:
    - src/execution/execution/manager.ts:130 (canonicalize for OKX)
    - src/execution/recovery/index.ts:132 (canonicalize in recovery)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX limit: clientOrderId max 32 chars, alphanumeric only. UUID with dashes = 36
    chars. After stripping: 32 chars, alphanumeric — exactly at the limit.
    If UUID hyphens are removed and length exceeds 32, the ID will be truncated
    or rejected — monitor this.

- id: strategy_1_ws.okx.STRATEGY_SPECIFIC.FUNDING_FEE_MATCHED_CORRECTLY
  category: STRATEGY_SPECIFIC
  severity: critical
  description: >
    Monitor matches ws.funding_fee only when exchange, symbol, AND fundingTime are all
    correct (±5000ms tolerance). OKX symbol normalization (BTC-USDT-SWAP → BTCUSDT)
    is applied before the bus event — the monitor receives the normalized symbol.
  preconditions:
    - intent in monitoring for (okx, symbolX, fundingTs=T)
  trigger_sequence:
    - bus: 'ws.funding_fee' {exchange: "okx", symbol: "BTCUSDT", fundingTime: T ± 3000ms}
  expected_behavior:
    - monitor listener: all 3 filters pass → settle('funding_fee', {source: 'ws'})
  observability_contract:
    - log: 'monitor.settle' {reason: "funding_fee", source: "ws", latencyMs: "<5000"}
  code_refs:
    - src/execution/execution/monitor.ts:199 (exchange filter)
    - src/execution/execution/monitor.ts:200 (symbol filter)
    - src/execution/execution/monitor.ts:201 (±5000ms timestamp tolerance)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: routine

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_1_ws.okx.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active at submit time. Preflight rejects the intent with code=kill_switch
    (OKX rate limit code 50011 is irrelevant here — kill switch fires before any REST call).
  preconditions:
    - kill switch mode != 'off'
    - strategy_1_ws condition met for okx
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
    - docs-strategy/strategies/strategy_1_ws.md (no kill switch in spec)
  status: ⏳
  natural_occurrence: occasional

- id: strategy_1_ws.okx.SPEC_DIVERGENCE.OKX_RATE_LIMIT_ON_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    OKX returns rate-limit error (code 50011) during the REST createOrder call (or WS
    adapter equivalent). Manager catch block calls setError('create_order_failed').
    Intent becomes terminal. OKX rate limit surfaces as err.message containing '50011'.
  preconditions:
    - WS adapter or REST createOrder receives OKX error 50011
  trigger_sequence:
    - createOrder call → OKX returns {code: "50011", msg: "Too many requests"}
    - CCXT wraps as RateLimitExceeded
    - manager catch → setError('create_order_failed', err.message)
  expected_behavior:
    - intent.error {code: "create_order_failed"} with err.message containing '50011'
    - no retry at this level
    - intent terminal
  observability_contract:
    - log: 'intent.error' {code: "create_order_failed", message: "contains 50011"}
    - db:intentLifecycleEvents submitted→error
  code_refs:
    - src/execution/execution/manager.ts:2707 (createOrder catch → setError)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (no rate-limit handling in spec)
  status: ⏳
  natural_occurrence: rare
  notes: >
    Cross-cutting: see checklists/_cross_cutting.md §3 RATE LIMIT HANDLING.
```
