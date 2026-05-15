# Checklist — gateio / strategy_1

Exchange: **gateio**
Strategy: **strategy_1** (Negative Funding LONG — Instant Exit)
Spec: `docs-strategy/strategies/strategy_1.md`
Code: `src/execution/strategies/strategy_1.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/gateio.ts`

---

**GateIO-specific notes:**
- No clientOrderId transformation (no canonicalize dash-strip)
- Private WS: futures order fills on `futures.orders` channel; timestamps in **seconds** (× 1000 to get ms)
- Funding fee events: `account.book` channel with `bizType` containing fund-related text
- `cancelIgnoreCode: 'TEXT_DUPLICATED'` — OKX-style cancel dedupe response treated as success
- Symbol normalization applied in recovery (`recovery.ts:302-305`): GateIO symbol (e.g. `BTC_USDT`) normalized to `BTCUSDT`
- Rate limit: CCXT `RateLimitExceeded` class (no numeric code)

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_1.gateio.ORDER_LIFECYCLE.ENTRY_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - entryOffsetSeconds (default 5s). Preflight passes.
    setLeverage succeeds. A market BUY order (LONG) is placed via REST createOrder.
    No clientOrderId transformation for GateIO (no canonicalize). order.placed logged
    with kind=entry, side=buy, orderType=market, reduceOnly=false.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent (default -0.4%)
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - market status = trading
  trigger_sequence:
    - scheduler: evaluator fires at entryAt = nextFundingTimestamp - entryOffsetSeconds * 1000
    - manager.submit() called with strategy_1 TradeIntent (exchange=gateio)
  expected_behavior:
    - intent.created logged (strategy=strategy_1, exchange=gateio)
    - intent.submitted logged (entryKind=market)
    - order.placed logged (kind=entry, side=buy, orderType=market, reduceOnly=false)
    - status transitions decided → submitted → acked → working
    - entry clientOrderId registered in byEntryOrderId (no transformation)
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_1", exchange: "gateio"}
    - log: 'intent.submitted' {entryKind: "market"}
    - log: 'order.placed' {kind: "entry", side: "buy", orderType: "market", reduceOnly: false}
    - db:orders row {kind: "entry", orderType: "market", reduceOnly: false, status: "pending"}
    - db:intentLifecycleEvents transitions decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:1984 (submit)
    - src/execution/execution/manager.ts:2081 (transition submitted)
    - src/execution/execution/manager.ts:2655 (market entry path)
    - src/execution/execution/manager.ts:2697 (createOrder call)
    - src/execution/execution/manager.ts:2755 (order.placed log)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (Execution Flow step 1)
  status: ⏳
  natural_occurrence: routine
  notes: >
    GateIO has no clientOrderId transformation. GateIO REST createOrder returns
    exchangeOrderId in the ACK. The entry clientOrderId is registered in byEntryOrderId
    before the REST call so any racing WS fill event is not lost.

- id: strategy_1.gateio.ORDER_LIFECYCLE.ENTRY_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Entry market order fills. GateIO private WS emits on 'futures.orders' channel.
    Timestamps in the WS event are in SECONDS — the adapter multiplies by 1000 to
    get milliseconds before emitting the bus event. Manager routes via byEntryOrderId
    lookup using clientOrderId, logs order.filled, transitions to filled, then
    handleEntryFilled emits position.opened and arms the timed monitor.
  preconditions:
    - entry order placed (status=working or acked)
    - GateIO private WS connected
  trigger_sequence:
    - GateIO WS: 'futures.orders' channel event {status: "filled", text: <clientOrderId>}
    - adapter multiplies timestamps by 1000 (seconds → ms)
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice present)
    - status transitions working → filled → monitoring
    - position.opened logged (side=long, filledQty > 0)
    - monitor.armed.timed logged (debug) with delay to T_f + exitOffsetSeconds
    - no SL/TP placed
  observability_contract:
    - log: 'order.filled' {exchange: "gateio", filledQty: ">0"}
    - log: 'position.opened' {side: "long", filledQty: ">0"}
    - log: 'monitor.armed.timed' {delay: "~7000ms from now"}  # debug level
    - db:orders row {kind: "entry", status: "filled", filledQty: ">0"}
    - db:intentLifecycleEvents transition filled→monitoring
  code_refs:
    - src/execution/adapters/privatews/gateio.ts (futures.orders channel handler)
    - src/execution/execution/manager.ts:1136 (handleEntryOrderEvent fill branch)
    - src/execution/execution/manager.ts:1156 (order.filled log)
    - src/execution/execution/manager.ts:782 (position.opened log)
    - src/execution/execution/monitor.ts:97 (monitor.armed.timed debug log)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (Entry fill → arm timed monitor)
  status: ⏳
  natural_occurrence: routine
  notes: >
    GateIO WS timestamps are in seconds, not milliseconds. The GateIO adapter converts
    to ms before processing. Failure to convert would cause timestamp mismatch in DB
    and potentially incorrect monitor timing. Verify adapter does: ts * 1000.

- id: strategy_1.gateio.ORDER_LIFECYCLE.ENTRY_REST_POLL_FALLBACK
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    GateIO WS 'futures.orders' fill event does not arrive within 15s poll window.
    pollForEntryFill (15×1s REST getOrder) detects the fill and drives intent to
    filled→monitoring.
  preconditions:
    - entry order placed (status=working)
    - WS fill event not received
  trigger_sequence:
    - pollForEntryFill: getOrder returns status=filled
  expected_behavior:
    - order.filled logged (from poll path)
    - status transitions working → filled → monitoring
    - position.opened logged
    - monitor armed (timed)
  observability_contract:
    - log: 'order.filled' (from poll, no prior WS fill)
    - log: 'position.opened'
    - db:intentLifecycleEvents working→filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:1179 (pollForEntryFill)
    - src/execution/execution/manager.ts:2787 (poll started after REST ack)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    GateIO WS is generally reliable for market orders. REST poll is safety net.

- id: strategy_1.gateio.ORDER_LIFECYCLE.CLOSE_MARKET_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Monitor fires at exitAt = T_f + exitOffsetSeconds*1000. handleMonitorExit places
    a market SELL reduce-only close via REST createOrder. GateIO close order is a
    market sell with reduceOnly=true. Close fill detected via WS or pollForCloseFill.
  preconditions:
    - intent in status=monitoring
    - timed monitor fires at exitAt
  trigger_sequence:
    - setTimeout fires at exitAt - skewMs
    - monitor.settle('timed') → handleMonitorExit
    - REST createOrder {side: "sell", type: "market", reduceOnly: true}
  expected_behavior:
    - monitor.settle {reason: "timed"} logged
    - intent.exiting.start {reason: "timed"} logged
    - order.placed {kind: "timed", side: "sell", orderType: "market", reduceOnly: true}
    - close fill detected → intent.exited.complete or db transition exiting→exited
  observability_contract:
    - log: 'monitor.settle' {reason: "timed"}
    - log: 'intent.exiting.start' {reason: "timed"}
    - log: 'order.placed' {kind: "timed", side: "sell", orderType: "market", reduceOnly: true}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:97 (timed arm — setTimeout at exitAt - skewMs)
    - src/execution/execution/monitor.ts:47 (monitor.exit_requested log)
    - src/execution/execution/monitor.ts:93 (monitor.settle log)
    - src/execution/execution/manager.ts:1479 (intent.exiting.start)
    - src/execution/execution/manager.ts:1585 (closeKind='timed')
    - src/execution/execution/manager.ts:1660 (order.placed close)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (Exit at T_f + exitOffsetSeconds)
  status: ⏳
  natural_occurrence: routine

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_1.gateio.TIMING.ENTRY_AT_CORRECT_OFFSET
  category: TIMING
  severity: high
  description: >
    Entry REST createOrder placed at approximately T_f - 5s. Elapsed time from
    entryAt to order.placed should be within a few hundred ms (REST latency + setLeverage).
    GateIO REST latency typically 50-200ms.
  preconditions:
    - scheduler running, strategy condition met
  trigger_sequence:
    - scheduler fires at entryAt = nextFundingTimestamp - entryOffsetSeconds*1000
  expected_behavior:
    - intent.submitted timestamp <= entryAt + 1000ms
    - order.placed (kind=entry) timestamp <= entryAt + 1500ms
  observability_contract:
    - log: 'intent.submitted' timestamp <= entryAt + 1000ms
    - log: 'order.placed' {kind: "entry"} timestamp <= entryAt + 1500ms
  code_refs:
    - src/execution/strategies/strategy_1.ts:47 (entryAt = nextFundingTimestamp - entryOffsetSeconds*1000)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (Entry offset T_entry = T_funding − 5s)
  status: ⏳
  natural_occurrence: routine

- id: strategy_1.gateio.TIMING.TIMED_EXIT_AT_CORRECT_OFFSET
  category: TIMING
  severity: critical
  description: >
    Monitor fires at exitAt = T_f + exitOffsetSeconds*1000 (default +7s after T_f).
    The close market sell is placed promptly after the timer fires. skewMs is subtracted
    from the delay to account for timer imprecision.
  preconditions:
    - intent in status=monitoring
  trigger_sequence:
    - setTimeout fires at exitAt - skewMs
    - monitor.settle('timed')
  expected_behavior:
    - monitor fires within a few ms of exitAt
    - close order placed within 500ms of exitAt
  observability_contract:
    - log: 'monitor.settle' {reason: "timed"} timestamp ≈ exitAt
    - log: 'order.placed' {kind: "timed"} timestamp ≈ exitAt + <REST latency>
  code_refs:
    - src/execution/execution/monitor.ts:97 (setTimeout at exitAt - skewMs)
    - src/execution/execution/monitor.ts:99 (settleTime = exitAt, reason = 'timed')
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (Exit at T_f + 7s)
  status: ⏳
  natural_occurrence: routine

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_1.gateio.WEBSOCKET.RECONNECT_TRIGGERS_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    GateIO private WS disconnects and reconnects while intent is in monitoring.
    store.reconcile() called on reconnect. REST getOpenOrders + getPositions fetched.
    The timed monitor remains armed (not reset by reconnect).
  preconditions:
    - intent in monitoring
    - GateIO WS disconnects then reconnects
  trigger_sequence:
    - ws.connection {state: "disconnected"} then {state: "connected"}
    - store.reconcile('gateio') called
  expected_behavior:
    - REST getOpenOrders + getPositions fetched
    - state maps updated
    - monitor timer unchanged (continues to fire at original exitAt)
    - no duplicate exit triggered
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal — no logger.info)
    - log: event='ws.connection' {exchange: "gateio", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - position qty consistent after reconcile
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile call)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    GateIO WS requires periodic ping/pong (20s interval). Reconnect after timeout
    triggers reconcile. Reconcile logs store.reconcile.complete at INFO on completion.

- id: strategy_1.gateio.WEBSOCKET.TIMESTAMP_SECONDS_CONVERSION
  category: WEBSOCKET
  severity: high
  description: >
    GateIO private WS events use SECOND-precision Unix timestamps. The GateIO WS
    adapter multiplies by 1000 before processing. If the conversion is missing or
    incorrect, all fill timestamps in DB will be off by ×1000, and monitor timing
    may be affected if timestamps are used for delay computation.
  preconditions:
    - GateIO WS active, fill events arriving
  trigger_sequence:
    - GateIO WS: futures.orders event with timestamp in seconds
    - adapter: ts_ms = raw_ts * 1000
  expected_behavior:
    - db:fills createdAt is in correct ms range (year 2025-2026)
    - db:orders filledAt is in correct ms range
    - NOT: db:fills with timestamps near 1970 or year 55000 (off by 1000)
  observability_contract:
    - db:fills createdAt: > 1700000000000 (ms after 2023)
    - log: 'order.filled' timestamp: reasonable wall clock value
  code_refs:
    - src/execution/adapters/privatews/gateio.ts (timestamp conversion: ts * 1000)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    This is a persistent GateIO-specific risk. If a new WS channel is added without
    the ×1000 conversion, timestamps will be wrong. Verify on each new channel used.

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_1.gateio.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_1 intent is in status=monitoring. Recovery
    rehydrates IntentState from DB. manager.start() re-arms the timed monitor for
    all monitoring intents. GateIO symbol normalization in recovery.ts:302-305:
    GateIO symbols (BTC_USDT) are normalized to BTCUSDT for consistent lookup.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=timed, exitAt in future or past
  trigger_sequence:
    - process restart → runRecovery() → manager.start() re-arms monitoring intents
  expected_behavior:
    - 'recovery: rehydrated intent states' logged (rehydratedCount >= 1)
    - monitor.armed.timed logged (debug) with new delay = max(0, exitAt - now)
    - if exitAt already past: timer fires immediately (delay=0)
    - close order placed immediately on timer fire
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.timed' {delay: ">=0"}  # debug level
    - if exitAt past: log: 'monitor.settle' {reason: "timed"} immediately after
  code_refs:
    - src/execution/recovery/index.ts:302 (GateIO symbol normalization)
    - src/execution/recovery/index.ts:245 (rehydrated intent states log)
    - src/execution/execution/manager.ts:1888 (start — re-arm monitoring intents)
    - src/execution/execution/monitor.ts:97 (timed arm — delay = max(0, exitAt - now - skewMs))
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    GateIO symbol normalization at recovery.ts:302-305 maps GateIO's underscore-separated
    symbol format (BTC_USDT) to the normalized form (BTCUSDT) used in the intent's symbol
    field. This ensures byEntryOrderId and byCloseOrderId lookups succeed after recovery.

- id: strategy_1.gateio.RECOVERY.ORPHAN_ORDER_CANCEL_TEXT_DUPLICATED
  category: RECOVERY
  severity: medium
  description: >
    During recovery, orphan order cancellation calls REST cancelOrder on GateIO.
    GateIO may return 'TEXT_DUPLICATED' error when cancelling an order that was
    already cancelled or filled. The cancelIgnoreCode='TEXT_DUPLICATED' causes the
    cancel to be treated as success (not an error). Recovery proceeds normally.
  preconditions:
    - recovery finds orphan orders resting in GateIO book
    - GateIO returns TEXT_DUPLICATED on cancelOrder (order already gone)
  trigger_sequence:
    - recovery: 'recovery: orphan order found, cancelling' logged
    - cancelOrder → GateIO returns TEXT_DUPLICATED
    - cancelIgnoreCode check: TEXT_DUPLICATED → treated as success
  expected_behavior:
    - no error thrown by cancelOrder
    - recovery continues to next orphan
    - no 'recovery: orphan cancel failed' log
  observability_contract:
    - log: 'recovery: orphan order found, cancelling' (no subsequent error for TEXT_DUPLICATED)
    - recovery proceeds normally (rehydrated states logged)
  code_refs:
    - src/execution/recovery/index.ts:271 (orphan cancel loop)
    - src/execution/adapters/gateio.ts (cancelIgnoreCode: 'TEXT_DUPLICATED' handling)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    TEXT_DUPLICATED is GateIO's idempotent cancel response. Without ignoring it, recovery
    would fail on every already-cancelled order. Verify in logs that cancel succeeds
    silently for TEXT_DUPLICATED.

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_1.gateio.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active at submit time. Preflight rejects with code=kill_switch.
    No GateIO REST call made.
  preconditions:
    - kill switch mode != 'off'
    - strategy_1 condition met for gateio
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
    - src/execution/execution/preflight.ts:32 (kill switch check)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (no kill switch in spec)
  status: ⏳
  natural_occurrence: occasional

- id: strategy_1.gateio.SPEC_DIVERGENCE.GATEIO_RATE_LIMIT
  category: SPEC_DIVERGENCE
  severity: medium
  description: >
    GateIO returns a rate-limit error during REST createOrder. CCXT wraps this as
    RateLimitExceeded (no numeric code — string class). Manager catch block calls
    setError('create_order_failed'). Intent becomes terminal. err.message will contain
    GateIO rate-limit response text.
  preconditions:
    - GateIO REST createOrder receives rate-limit response
  trigger_sequence:
    - createOrder → CCXT RateLimitExceeded thrown
    - manager catch → setError('create_order_failed', err.message)
  expected_behavior:
    - intent.error {code: "create_order_failed"} with GateIO rate-limit message
    - no retry
    - intent terminal
  observability_contract:
    - log: 'intent.error' {code: "create_order_failed", message: "contains rate limit text"}
    - db:intentLifecycleEvents submitted→error
  code_refs:
    - src/execution/execution/manager.ts:2707 (createOrder catch → setError)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: rare
  notes: >
    Cross-cutting: see checklists/_cross_cutting.md §3 RATE LIMIT HANDLING.
    GateIO rate limit: CCXT RateLimitExceeded class (not a numeric code).
```
