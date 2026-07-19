# Checklist — kucoin / strategy_1

Exchange: **kucoin**
Strategy: **strategy_1** (Negative Funding LONG — Instant Exit)
Spec: `docs-strategy/strategies/strategy_1.md`
Code: `src/execution/strategies/strategy_1.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/kucoin.ts`

---

**KuCoin-specific notes (CRITICAL):**

- KuCoin does NOT echo `clientOrderId` in market order WS fill events → `byEntryOrderId` lookup by clientOrderId FAILS for market fills
- KuCoin uses `exchangeOrderId` as the primary fill routing key for market orders
- `pollForEntryFill` (15×1s REST) is the **PRIMARY** fill detection path for KuCoin market orders (not a fallback)
- WS fill events on `wallet.order` or `trade.orders` channel arrive but without clientOrderId for market orders
- Funding fee: `wallet.funding` WS channel
- `cancelIgnoreCode: 100004` (order not found — treated as success for cancel)
- ms timestamps (no seconds conversion needed)
- No clientOrderId transformation
- KuCoin rate limit: HTTP 429

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_1.kucoin.ORDER_LIFECYCLE.ENTRY_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. setLeverage succeeds. A market BUY
    (LONG) is placed via REST createOrder. No clientOrderId transformation for KuCoin.
    order.placed logged. Because KuCoin market fills do NOT echo clientOrderId in WS
    events, byEntryOrderId is registered but the WS path will NOT be the primary fill
    detection method. pollForEntryFill starts immediately.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - market status = trading
  trigger_sequence:
    - scheduler fires at entryAt → manager.submit() → REST createOrder (BUY market)
    - byEntryOrderId registered with clientOrderId (may not match WS event key for KuCoin)
    - pollForEntryFill starts immediately (15 × 1s)
  expected_behavior:
    - intent.created logged (strategy=strategy_1, exchange=kucoin)
    - intent.submitted logged (entryKind=market)
    - order.placed logged (kind=entry, side=buy, orderType=market, reduceOnly=false)
    - status decided → submitted → acked → working
    - pollForEntryFill running in background (PRIMARY fill detection on KuCoin)
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_1", exchange: "kucoin"}
    - log: 'intent.submitted' {entryKind: "market"}
    - log: 'order.placed' {kind: "entry", side: "buy", orderType: "market", reduceOnly: false}
    - db:orders row {kind: "entry", orderType: "market", status: "pending"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:2697 (REST createOrder)
    - src/execution/execution/manager.ts:2755 (order.placed log)
    - src/execution/execution/manager.ts:2787 (pollForEntryFill started)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (Execution Flow step 1)
  status: ⏳
  natural_occurrence: routine
  notes: >
    KuCoin market orders: the REST ACK returns exchangeOrderId. byEntryOrderId may be
    keyed by exchangeOrderId for KuCoin specifically (verify adapter behavior). The
    clientOrderId echo is unreliable for KuCoin market fills. Primary detection: REST poll.

- id: strategy_1.kucoin.ORDER_LIFECYCLE.ENTRY_FILLED_REST_POLL
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    This is the PRIMARY fill detection path for KuCoin market orders.
    pollForEntryFill (15 × 1s) calls REST getOrder by exchangeOrderId. When status=filled
    is returned, manager calls handleEntryFilled → position.opened + monitor.armed.timed.
    The WS fill event (if it arrives) is deduplicated by the TERMINAL guard.
  preconditions:
    - entry order placed (status=working)
    - KuCoin REST getOrder accessible
  trigger_sequence:
    - pollForEntryFill: getOrder(exchangeOrderId) returns status=filled within 15 polls
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice from REST response)
    - status transitions working → filled → monitoring
    - position.opened logged (side=long)
    - monitor.armed.timed logged (debug)
    - no SL/TP placed
  observability_contract:
    - log: 'order.filled' {exchange: "kucoin", filledQty: ">0"}
    - log: 'position.opened' {side: "long"}
    - log: 'monitor.armed.timed' {delay: "~7000ms"}
    - db:orders {kind: "entry", status: "filled", filledQty: ">0"}
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — 15 × 1s)
    - src/execution/execution/manager.ts:2787 (poll started after REST ack)
    - src/execution/execution/manager.ts:782 (position.opened log)
    - src/execution/execution/monitor.ts:97 (monitor.armed.timed)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    KuCoin PRIMARY path: REST poll is NOT a fallback here. For KuCoin market orders,
    the poll is designed to be the reliable detection method. WS fill events from
    KuCoin may arrive with no clientOrderId (anonymous fill), making WS routing unreliable.
    The TERMINAL guard ensures handleEntryFilled is idempotent if both paths fire.

- id: strategy_1.kucoin.ORDER_LIFECYCLE.ENTRY_POLL_EXHAUSTED
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    pollForEntryFill exhausts all 15 polls (15s window) without the entry order showing
    as filled. This indicates the order did not fill (market moved) or REST is slow.
    Manager calls setError('entry_poll_exhausted') after the 15th poll returns not-filled.
    Intent transitions to error.
  preconditions:
    - entry market order placed but not filled after 15s
    - KuCoin REST getOrder returns status != filled for 15 consecutive polls
  trigger_sequence:
    - pollForEntryFill: 15 polls × 1s all return status != filled
    - setError(s, 'entry_poll_exhausted')
  expected_behavior:
    - intent.error logged with code=entry_poll_exhausted
    - db:intentLifecycleEvents working→error
    - no position.opened
    - no SL/TP placed
  observability_contract:
    - log: 'intent.error' {code: "entry_poll_exhausted"}
    - db:intentLifecycleEvents working→error
    - db:orders {kind: "entry", status: "pending" or "working"} (not filled)
  code_refs:
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — 15 polls, then error)
    - src/execution/execution/manager.ts:1227 (entry_poll_exhausted setError)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    KuCoin market orders almost always fill immediately. This scenario occurs if the
    order fails silently (position not opened) or REST getOrder is unavailable for >15s.

- id: strategy_1.kucoin.ORDER_LIFECYCLE.CLOSE_MARKET_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Monitor fires at exitAt (T_f + exitOffsetSeconds). handleMonitorExit places market
    SELL reduce-only close via REST createOrder. Close fill detected via WS or
    pollForCloseFill (20 × 1s). KuCoin close fill WS may also lack clientOrderId.
  preconditions:
    - intent in monitoring, timed monitor fires
  trigger_sequence:
    - setTimeout fires at exitAt - skewMs
    - monitor.settle('timed') → handleMonitorExit
    - REST createOrder {side: "sell", type: "market", reduceOnly: true}
  expected_behavior:
    - monitor.settle {reason: "timed"} logged
    - intent.exiting.start {reason: "timed"} logged
    - order.placed {kind: "timed", side: "sell", orderType: "market", reduceOnly: true}
    - close fill detected (REST poll PRIMARY on KuCoin for market close too)
  observability_contract:
    - log: 'monitor.settle' {reason: "timed"}
    - log: 'intent.exiting.start' {reason: "timed"}
    - log: 'order.placed' {kind: "timed", side: "sell", reduceOnly: true}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:97 (timed arm)
    - src/execution/execution/manager.ts:1585 (closeKind='timed')
    - src/execution/execution/manager.ts:1660 (order.placed close)
    - src/execution/execution/manager.ts:1235 (pollForCloseFill — 20 × 1s)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (Exit at T_f + exitOffsetSeconds)
  status: ⏳
  natural_occurrence: routine

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_1.kucoin.TIMING.ENTRY_AT_CORRECT_OFFSET
  category: TIMING
  severity: high
  description: >
    Entry REST createOrder placed at approximately T_f - 5s. KuCoin REST latency
    typically 100-300ms. pollForEntryFill started immediately after REST ACK.
    Fill should be detected within the first 1-3 polls (1-3s after REST ACK).
  preconditions:
    - scheduler fires at entryAt
  trigger_sequence:
    - scheduler: fires at entryAt = nextFundingTimestamp - entryOffsetSeconds*1000
  expected_behavior:
    - order.placed timestamp ≤ entryAt + 1500ms
    - order.filled (from poll) within entryAt + 3000ms
  observability_contract:
    - log: 'order.placed' {kind: "entry"} at ≤ entryAt + 1500ms
    - log: 'order.filled' within 3000ms of order.placed
  code_refs:
    - src/execution/strategies/strategy_1.ts:47 (entryAt computation)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (T_entry = T_funding − 5s)
  status: ⏳
  natural_occurrence: routine

- id: strategy_1.kucoin.TIMING.TIMED_EXIT_AT_CORRECT_OFFSET
  category: TIMING
  severity: critical
  description: >
    Monitor fires at exitAt = T_f + exitOffsetSeconds*1000. Close market sell placed
    via REST. KuCoin ms timestamps. Close fill detected via REST poll (pollForCloseFill).
  preconditions:
    - intent in monitoring
  trigger_sequence:
    - setTimeout at exitAt - skewMs → monitor.settle('timed')
  expected_behavior:
    - close order placed within 500ms of exitAt
    - close fill detected within pollForCloseFill window (20s)
  observability_contract:
    - log: 'monitor.settle' {reason: "timed"} at ≈ exitAt
    - log: 'order.placed' {kind: "timed"} at ≈ exitAt + <REST latency>
  code_refs:
    - src/execution/execution/monitor.ts:97 (timed arm)
    - src/execution/execution/monitor.ts:99 (exitAt)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: routine

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_1.kucoin.WEBSOCKET.RECONNECT_TRIGGERS_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    KuCoin private WS disconnects and reconnects while intent is in monitoring.
    store.reconcile called on reconnect. REST getOpenOrders + getPositions fetched.
    Timed monitor remains armed.
  preconditions:
    - intent in monitoring, KuCoin WS disconnects then reconnects
  trigger_sequence:
    - ws.connection {state: "disconnected"} then {state: "connected"}
    - store.reconcile('kucoin')
  expected_behavior:
    - REST fetch updates state maps
    - monitor timer unchanged
    - no duplicate exit
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal — no logger.info)
    - log: event='ws.connection' {exchange: "kucoin", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - position consistent after reconcile
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_1.kucoin.WEBSOCKET.KUCOIN_MARKET_FILL_NO_CLIENT_ORDER_ID
  category: WEBSOCKET
  severity: critical
  description: >
    KuCoin private WS emits a fill event for the entry market order WITHOUT echoing
    the clientOrderId. The byEntryOrderId lookup by clientOrderId FAILS. The WS fill
    event is NOT routed to handleEntryOrderEvent. The intent remains in working state.
    pollForEntryFill (already running) detects the fill via REST and processes it.
    The WS event is effectively ignored for routing purposes.
  preconditions:
    - entry market order placed (status=working)
    - KuCoin WS emits fill without clientOrderId
    - pollForEntryFill running in parallel
  trigger_sequence:
    - KuCoin WS: fill event {exchangeOrderId: <id>, clientOrderId: null/absent}
    - byEntryOrderId lookup by clientOrderId → misses
    - pollForEntryFill: REST getOrder → status=filled → handleEntryFilled called
  expected_behavior:
    - WS fill event NOT routed (no order.filled log from WS path)
    - pollForEntryFill detects fill within 1-3s
    - order.filled logged from REST poll path
    - intent transitions normally to monitoring
    - no error logged for unrouted WS event
  observability_contract:
    - log: 'order.filled' (from poll, not WS — poll fires first for KuCoin)
    - log: 'position.opened' {side: "long"}
    - log: 'monitor.armed.timed'
    - NO unmatched WS fill error in logs
  code_refs:
    - src/execution/execution/manager.ts:1898 (ws.order handler — lookup by clientOrderId)
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — PRIMARY for KuCoin)
    - src/execution/adapters/privatews/kucoin.ts (KuCoin order event — missing clientOrderId)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    This is the defining KuCoin behavioral quirk. It is NORMAL for KuCoin market orders.
    The WS fill event arriving without clientOrderId is expected and harmless — the REST
    poll path is the designed fill detection mechanism for KuCoin. Verify that unmatched
    WS fill events do NOT cause error logs or intent state regressions.

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_1.kucoin.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_1 intent is in monitoring on KuCoin. Recovery
    rehydrates IntentState. manager.start() re-arms timed monitor. cancelIgnoreCode=100004
    used for any orphan cancels during recovery. ms timestamps throughout.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=timed, exitAt in future or past
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor.armed.timed logged (debug) with new delay = max(0, exitAt - now)
    - if exitAt past: timer fires immediately → close order placed
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.timed' {delay: ">=0"}
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated states log)
    - src/execution/execution/manager.ts:1888 (re-arm monitoring intents)
    - src/execution/execution/monitor.ts:97 (timed arm)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Recovery orphan cancel: KuCoin error 100004 (order not found) treated as success
    (cancelIgnoreCode=100004). This prevents recovery from failing when an orphan order
    was already filled or cancelled before recovery ran.

- id: strategy_1.kucoin.RECOVERY.ORPHAN_CANCEL_CODE_100004
  category: RECOVERY
  severity: medium
  description: >
    During recovery, orphan order cancellation calls REST cancelOrder on KuCoin.
    KuCoin returns error 100004 (order not found) when cancelling an already-cancelled
    or filled order. cancelIgnoreCode=100004 causes this to be treated as success.
    Recovery proceeds normally.
  preconditions:
    - recovery finds orphan orders
    - KuCoin returns 100004 on cancelOrder
  trigger_sequence:
    - 'recovery: orphan order found, cancelling' logged
    - cancelOrder → KuCoin: error 100004
    - cancelIgnoreCode check: 100004 → success
  expected_behavior:
    - no error thrown
    - recovery continues to next orphan
  observability_contract:
    - log: 'recovery: orphan order found, cancelling' (no subsequent error for code 100004)
    - recovery: rehydrated intent states logged (recovery completed)
  code_refs:
    - src/execution/recovery/index.ts:271 (orphan cancel loop)
    - src/execution/adapters/kucoin.ts (cancelIgnoreCode: 100004)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_1.kucoin.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects with code=kill_switch. No KuCoin REST call.
  preconditions:
    - kill switch mode != 'off', strategy_1 condition met for kucoin
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
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_1.kucoin.SPEC_DIVERGENCE.KUCOIN_POLL_AS_PRIMARY_FILL_PATH
  category: SPEC_DIVERGENCE
  severity: critical
  description: >
    Spec assumes WS fill events are the primary fill detection mechanism (as on Binance/OKX).
    On KuCoin, market order WS fill events lack clientOrderId, making WS routing unreliable.
    The implementation uses pollForEntryFill as the PRIMARY fill detection for KuCoin.
    This is an exchange-specific behavior not mentioned in the strategy spec.
  preconditions:
    - strategy_1 intent submitted for kucoin
    - market order fill event arrives on KuCoin private WS
  trigger_sequence:
    - KuCoin WS fill event has no clientOrderId → byEntryOrderId lookup misses
    - pollForEntryFill detects fill via REST getOrder
  expected_behavior:
    - fill detected within 1-15s via REST poll (not via WS routing)
    - intent transitions normally to monitoring
  observability_contract:
    - log: 'order.filled' from REST poll path (not WS path)
    - no 'order not found in byEntryOrderId' error
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (market fill: no clientOrderId echo)
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — PRIMARY for KuCoin)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (WS fill assumed primary in spec)
  status: ⏳
  natural_occurrence: routine
  notes: >
    This is the most important KuCoin behavioral distinction. All strategies on KuCoin
    with market orders rely on REST polling as the primary fill detection mechanism.
    Monitor this carefully in live operation to ensure poll latency is acceptable.
```
