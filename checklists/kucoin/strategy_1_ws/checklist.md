# Checklist — kucoin / strategy_1_ws

Exchange: **kucoin**
Strategy: **strategy_1_ws** (Negative Funding LONG — Funding-Fee Event Exit)
Spec: `docs-strategy/strategies/strategy_1_ws.md`
Code: `src/execution/strategies/strategy_1_ws.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/kucoin.ts`

---

**KuCoin-specific notes (CRITICAL):**

- WS entry via WS order adapter (requiresWsOrderAdapter=true)
- KuCoin does NOT echo `clientOrderId` for market fills in WS events → `pollForEntryFill` is PRIMARY fill path
- Funding fee: `wallet.funding` WS channel
- `cancelIgnoreCode: 100004` (order not found = success)
- ms timestamps throughout
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_1_ws.kucoin.ORDER_LIFECYCLE.ENTRY_PLACED_VIA_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. orderClient() resolves to the
    WS order adapter (requiresWsOrderAdapter('strategy_1_ws')=true). A market BUY is
    placed via the WS adapter. No clientOrderId transformation on KuCoin. order.placed
    logged. Because KuCoin market fills do NOT echo clientOrderId in WS events,
    pollForEntryFill is started immediately as the PRIMARY fill detection mechanism.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - WS order adapter available for kucoin
  trigger_sequence:
    - scheduler fires at entryAt → manager.submit() → WS adapter createOrder
    - pollForEntryFill started immediately (PRIMARY)
    - bus.on('ws.funding_fee') listener registered (for exit)
    - timeoutHandle set at timeoutAt
  expected_behavior:
    - intent.created logged (strategy=strategy_1_ws, exchange=kucoin)
    - intent.submitted logged (entryKind=market)
    - order.placed (kind=entry, side=buy, orderType=market) logged
    - status decided → submitted → acked → working
    - pollForEntryFill running (PRIMARY for KuCoin)
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_1_ws", exchange: "kucoin"}
    - log: 'intent.submitted' {entryKind: "market"}
    - log: 'order.placed' {kind: "entry", side: "buy", orderType: "market"}
    - db:orders {kind: "entry", status: "pending"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:90 (requiresWsOrderAdapter — true for strategy_1_ws)
    - src/execution/execution/manager.ts:96 (orderClient → WS adapter)
    - src/execution/execution/manager.ts:2755 (order.placed log)
    - src/execution/execution/manager.ts:2787 (pollForEntryFill start — PRIMARY)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (WS adapter required)
  status: ⏳
  natural_occurrence: routine
  notes: >
    KuCoin WS market fills lack clientOrderId → byEntryOrderId lookup unreliable.
    pollForEntryFill (15×1s REST) is PRIMARY. The WS fill event arrives but cannot be
    routed. TERMINAL guard prevents double-processing if both paths fire.

- id: strategy_1_ws.kucoin.ORDER_LIFECYCLE.ENTRY_FILLED_REST_POLL
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    PRIMARY fill detection on KuCoin. pollForEntryFill (15×1s REST getOrder by exchangeOrderId)
    detects fill. handleEntryFilled called → position.opened + monitor.armed.funding_fee_event.
    The ws.funding_fee bus listener is already registered from the submit path.
  preconditions:
    - entry order placed (working), KuCoin REST accessible
  trigger_sequence:
    - pollForEntryFill: getOrder(exchangeOrderId) returns status=filled
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice from REST)
    - status working → filled → monitoring
    - position.opened logged (side=long)
    - monitor.armed.funding_fee_event logged (debug)
    - no SL/TP placed
  observability_contract:
    - log: 'order.filled' {exchange: "kucoin", filledQty: ">0"}
    - log: 'position.opened' {side: "long"}
    - log: 'monitor.armed.funding_fee_event' {timeoutDelay, fundingTs}
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — PRIMARY for KuCoin)
    - src/execution/execution/manager.ts:782 (position.opened)
    - src/execution/execution/monitor.ts:210 (monitor.armed.funding_fee_event)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    For KuCoin: fill is detected via REST poll (1-15s), not WS routing.
    The TERMINAL guard prevents handleEntryFilled from being called twice.

- id: strategy_1_ws.kucoin.ORDER_LIFECYCLE.CLOSE_WS_REJECTED_REST_FALLBACK
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Monitor exit fires. WS adapter returns rejected for close order. Manager logs
    close.ws_rejected and retries via REST createOrder. REST close succeeds.
  preconditions:
    - intent in monitoring, WS adapter rejects close order
  trigger_sequence:
    - monitor.settle → handleMonitorExit → WS adapter → {status: 'rejected'}
    - REST fallback createOrder
  expected_behavior:
    - close.ws_rejected logged (error)
    - REST close placed (kind=close, side=sell, reduceOnly=true)
  observability_contract:
    - log: 'close.ws_rejected' {rejectReason}
    - log: 'order.placed' {kind: "close"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/manager.ts:1620 (ws_rejected check)
    - src/execution/execution/manager.ts:1625 (REST fallback)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_1_ws.kucoin.TIMING.FUNDING_FEE_EVENT_EXIT
  category: TIMING
  severity: critical
  description: >
    At T_f, KuCoin emits a funding fee credit event on the 'wallet.funding' WS channel.
    The KuCoin WS adapter maps this to ws.funding_fee on the bus. The monitor listener
    matches by exchange, symbol, and ±5000ms timestamp tolerance. settle('funding_fee')
    fires. Market close placed.
  preconditions:
    - intent in monitoring, KuCoin wallet.funding event received at T_f
  trigger_sequence:
    - KuCoin WS: wallet.funding {contract: <symbol>, fundingTime: <ms>}
    - adapter → bus.emit('ws.funding_fee', {exchange: "kucoin", symbol, fundingTime})
    - monitor listener matches → settle('funding_fee')
  expected_behavior:
    - monitor.exit_requested logged
    - monitor.settle {reason: "funding_fee", source: "ws"} logged
    - close order placed (kind=close, side=sell, reduceOnly=true)
  observability_contract:
    - log: 'monitor.exit_requested' {reason: "funding_fee"}
    - log: 'monitor.settle' {reason: "funding_fee", source: "ws", latencyMs: "<5000"}
    - log: 'order.placed' {kind: "close", side: "sell"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (wallet.funding handler)
    - src/execution/execution/monitor.ts:198 (bus.on ws.funding_fee)
    - src/execution/execution/monitor.ts:200 (±5000ms tolerance)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md (Exit: ws.funding_fee within ±5s)
  status: ⏳
  natural_occurrence: routine
  notes: >
    KuCoin wallet.funding channel provides funding fee events in ms timestamps.
    KuCoin symbol in wallet.funding may be in KuCoin format (BTC/USDT:USDT) —
    adapter normalizes to BTCUSDT before emitting ws.funding_fee.

- id: strategy_1_ws.kucoin.TIMING.FUNDING_FEE_TIMEOUT
  category: TIMING
  severity: high
  description: >
    ws.funding_fee not received before timeoutAt. Timeout fires. settle('funding_fee_timeout').
    Market close placed.
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

- id: strategy_1_ws.kucoin.WEBSOCKET.KUCOIN_MARKET_FILL_NO_CLIENT_ORDER_ID
  category: WEBSOCKET
  severity: critical
  description: >
    KuCoin private WS emits a fill event for the entry market order WITHOUT clientOrderId.
    The byEntryOrderId lookup by clientOrderId FAILS. WS event not routed. pollForEntryFill
    (already running) detects fill via REST. No error logged for unrouted WS event.
  preconditions:
    - entry market order placed (working)
    - KuCoin WS emits fill without clientOrderId
  trigger_sequence:
    - KuCoin WS: fill event {clientOrderId: null/absent, orderId: <exchangeOrderId>}
    - byEntryOrderId lookup misses
    - pollForEntryFill: REST getOrder → filled → handleEntryFilled
  expected_behavior:
    - WS fill NOT routed (no order.filled log from WS path)
    - pollForEntryFill detects fill within 1-15s
    - intent transitions to monitoring normally
  observability_contract:
    - log: 'order.filled' from REST poll (not WS routing)
    - NO 'byEntryOrderId lookup failed' error
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (no clientOrderId in market fill)
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — PRIMARY)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    KuCoin-specific behavior: NORMAL for market orders. REST poll is the designed
    primary fill detection. The WS fill event without clientOrderId is not an error.

- id: strategy_1_ws.kucoin.WEBSOCKET.RECONNECT_TRIGGERS_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    KuCoin WS disconnects and reconnects while intent is in monitoring.
    store.reconcile called. ws.funding_fee bus listener survives reconnect.
  preconditions:
    - intent in monitoring, waiting for ws.funding_fee
    - KuCoin WS disconnects and reconnects
  trigger_sequence:
    - ws.connection {state: "connected"} → store.reconcile('kucoin')
  expected_behavior:
    - REST getOpenOrders + getPositions fetched
    - ws.funding_fee bus listener still active
    - no duplicate exit
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal)
    - log: event='ws.connection' {exchange: "kucoin", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - position consistent after reconcile
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_1_ws.kucoin.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_1_ws intent is in monitoring on KuCoin. Recovery
    rehydrates IntentState. manager.start() re-arms funding_fee_event monitor.
    cancelIgnoreCode=100004 for orphan cancels. If timeoutAt past: fires immediately.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=funding_fee_event
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor.armed.funding_fee_event logged with new timeoutDelay
    - if timeoutAt past: settle('funding_fee_timeout') immediately
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.funding_fee_event' {timeoutDelay: ">=0"}
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated states)
    - src/execution/execution/manager.ts:1888 (re-arm)
    - src/execution/execution/monitor.ts:183 (funding_fee_event arm)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_1_ws.kucoin.SPEC_DIVERGENCE.KUCOIN_POLL_AS_PRIMARY_FILL_PATH
  category: SPEC_DIVERGENCE
  severity: critical
  description: >
    Spec assumes WS fill events (with clientOrderId) are the primary detection mechanism.
    KuCoin market order WS fills lack clientOrderId. Implementation uses pollForEntryFill
    as PRIMARY fill path for KuCoin. This extends fill detection latency by 1-15s
    compared to other exchanges but is the correct design for KuCoin.
  preconditions:
    - strategy_1_ws intent submitted for kucoin, entry fills
  trigger_sequence:
    - KuCoin WS fill: no clientOrderId → not routed
    - pollForEntryFill: REST detects fill within 1-15s
  expected_behavior:
    - fill detected via REST poll, not WS routing
    - fill latency 1-15s (vs <1s on Binance/OKX/Bybit)
  observability_contract:
    - log: 'order.filled' from REST poll path (NOT WS event routing)
    - no error for unrouted KuCoin WS fill events
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (market fill: no clientOrderId)
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — PRIMARY)
  spec_refs:
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_1_ws.kucoin.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No KuCoin WS call.
  preconditions:
    - kill switch mode != 'off', strategy_1_ws condition for kucoin
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
    - docs-strategy/strategies/strategy_1_ws.md
  status: ⏳
  natural_occurrence: occasional
```
