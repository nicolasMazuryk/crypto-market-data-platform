# Checklist — kucoin / strategy_3a

Exchange: **kucoin**
Strategy: **strategy_3a** (Negative Funding SHORT — sl_tp_deadline)
Spec: `docs-strategy/strategies/strategy_3a.md`
Code: `src/execution/strategies/strategy_3a.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/kucoin.ts`

---

**KuCoin-specific notes (CRITICAL):**

- REST entry (no WS adapter for strategy_3a)
- KuCoin does NOT echo `clientOrderId` for market fills in WS events → `pollForEntryFill` is PRIMARY fill path
- SHORT position: entry=SELL market, SL=buy stop_market, TP=buy limit
- `cancelIgnoreCode: 100004` (order not found = success) for OCO cancel
- ms timestamps throughout
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_3a.kucoin.ORDER_LIFECYCLE.ENTRY_PLACED_VIA_REST
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. Market SELL placed via REST
    createOrder (strategy_3a has no WS adapter). No clientOrderId transformation
    on KuCoin. pollForEntryFill started immediately as PRIMARY fill detection
    (KuCoin market fills lack clientOrderId in WS events regardless of entry method).
  preconditions:
    - fundingRatePercent > positiveFundingThresholdPercent (positive rate for SHORT)
    - available USDT >= amountUsd / leverage
    - kill switch inactive
  trigger_sequence:
    - scheduler fires at entryAt → manager.submit() → REST createOrder (sell, market)
    - pollForEntryFill started immediately (PRIMARY)
    - timeoutHandle set at timeoutAt
  expected_behavior:
    - intent.created logged (strategy=strategy_3a, exchange=kucoin)
    - order.placed (kind=entry, side=sell, orderType=market) logged
    - pollForEntryFill running (PRIMARY for KuCoin)
    - status decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_3a", exchange: "kucoin"}
    - log: 'order.placed' {kind: "entry", side: "sell", orderType: "market"}
    - db:orders {kind: "entry", side: "sell", status: "pending"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:2755 (order.placed log)
    - src/execution/execution/manager.ts:2787 (pollForEntryFill start — PRIMARY)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    strategy_3a uses REST entry (requiresWsOrderAdapter=false). KuCoin market
    fill WS events still lack clientOrderId → pollForEntryFill is PRIMARY.

- id: strategy_3a.kucoin.ORDER_LIFECYCLE.ENTRY_FILLED_REST_POLL
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    PRIMARY fill detection on KuCoin. pollForEntryFill (15×1s REST getOrder by
    exchangeOrderId) detects fill. handleEntryFilled → position.opened (short).
    SL (buy stop_market, reduceOnly) + TP (buy limit, reduceOnly) placed via REST.
    monitor.armed.sl_tp_deadline logged. pollForSlTpFill started.
  preconditions:
    - entry sell order placed (working), KuCoin REST accessible
  trigger_sequence:
    - pollForEntryFill: getOrder(exchangeOrderId) returns status=filled
    - handleEntryFilled: SL (buy) + TP (buy) placed
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice from REST)
    - position.opened logged (side=short)
    - order.placed {kind: "sl", side: "buy", orderType: "stop_market"} logged
    - order.placed {kind: "tp", side: "buy", orderType: "limit"} logged
    - monitor.armed.sl_tp_deadline logged (debug)
    - status working → filled → monitoring
  observability_contract:
    - log: 'order.filled' {exchange: "kucoin", filledQty: ">0"}
    - log: 'position.opened' {side: "short"}
    - log: 'order.placed' {kind: "sl", side: "buy"}
    - log: 'order.placed' {kind: "tp", side: "buy"}
    - log: 'monitor.armed.sl_tp_deadline' (debug)
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — PRIMARY)
    - src/execution/execution/manager.ts:782 (position.opened)
    - src/execution/execution/manager.ts:406 (handleEntryFilled SL+TP)
    - src/execution/execution/monitor.ts:80 (monitor.armed.sl_tp_deadline)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_3a.kucoin.ORDER_LIFECYCLE.SL_FILLS_TP_CANCELED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    SL buy stop_market fills (short position covered at loss). KuCoin WS 'orders'
    channel emits fill for SL with clientOrderId (stop/limit orders DO echo
    clientOrderId on KuCoin). monitor.settle('sl'). handleMonitorExit cancels TP
    (cancelIgnoreCode=100004).
  preconditions:
    - intent in monitoring, SL and TP resting, price rises to SL stop price
  trigger_sequence:
    - KuCoin WS: orders {status: "filled", clientOrderId: <slId>}
    - monitor.settle('sl') → cancel TP (100004 OK)
  expected_behavior:
    - monitor.settle {reason: "sl"} logged
    - oco.cancel.start for TP (100004 = success)
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: <tpId>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:124 (ws.order SL listener)
    - src/execution/execution/manager.ts:1502 (cancel tp on sl)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_3a.kucoin.ORDER_LIFECYCLE.TP_FILLS_SL_CANCELED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    TP buy limit fills (short position covered at profit). KuCoin WS 'orders'
    emits fill for TP with clientOrderId. monitor.settle('tp'). handleMonitorExit
    cancels SL (cancelIgnoreCode=100004).
  preconditions:
    - intent in monitoring, TP resting, price drops to TP level (for short)
  trigger_sequence:
    - KuCoin WS: orders {status: "filled", clientOrderId: <tpId>}
    - monitor.settle('tp') → cancel SL (100004 OK)
  expected_behavior:
    - monitor.settle {reason: "tp"} logged
    - oco.cancel.start for SL (100004 = success)
    - intent.exited.complete {exitReason: "tp"}
  observability_contract:
    - log: 'monitor.settle' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: <slId>}
    - log: 'intent.exited.complete' {exitReason: "tp"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:131 (ws.order TP listener)
    - src/execution/execution/manager.ts:1504 (cancel sl on tp)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_3a.kucoin.TIMING.DEADLINE_FIRES_CANCEL_BOTH
  category: TIMING
  severity: critical
  description: >
    Neither SL nor TP fills before deadlineAt. Deadline fires. SL and TP cancelled
    (cancelIgnoreCode=100004 for each). Market close buy (reduceOnly) placed to
    cover the short position.
  preconditions:
    - intent in monitoring at deadlineAt, neither SL nor TP filled
  trigger_sequence:
    - monitor.settle('deadline') → cancel [sl, tp] (100004 OK each) → market buy close
  expected_behavior:
    - oco.cancel.start x2 (100004 = success each)
    - order.placed {kind: "close", side: "buy", reduceOnly: true}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'monitor.settle' {reason: "deadline"}
    - log: 'oco.cancel.start' x2
    - log: 'order.placed' {kind: "close", side: "buy"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:115 (deadline timer)
    - src/execution/execution/manager.ts:1578 (cancel refs)
    - src/execution/execution/manager.ts:1660 (market buy close)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: routine

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_3a.kucoin.OCO.KUCOIN_CANCEL_IGNORE_CODE_100004
  category: OCO
  severity: high
  description: >
    When one exit leg fills and cancelSiblingExit is called on the other,
    KuCoin may return error code 100004 (order not found — already filled/cancelled).
    cancelIgnoreCode=100004 ensures this is treated as success, not an error.
  preconditions:
    - intent in monitoring, one of SL/TP fills; sibling cancel race possible
  trigger_sequence:
    - monitor.settle('sl' or 'tp') → cancelOrder(siblingId) → KuCoin: 100004
    - cancelIgnoreCode=100004 → treat as success
  expected_behavior:
    - oco.cancel.start logged (no error)
    - intent proceeds to exited normally
  observability_contract:
    - log: 'oco.cancel.start' {clientOrderId: <siblingId>} (no error)
    - log: 'intent.exited.complete'
  code_refs:
    - src/execution/execution/manager.ts:1502 (cancelSiblingExit)
    - src/execution/adapters/rest/kucoin.ts (cancelIgnoreCode=100004)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: occasional

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_3a.kucoin.WEBSOCKET.KUCOIN_MARKET_FILL_NO_CLIENT_ORDER_ID
  category: WEBSOCKET
  severity: critical
  description: >
    KuCoin WS 'orders' channel emits fill for the entry market SELL order WITHOUT
    clientOrderId. byEntryOrderId lookup FAILS silently. pollForEntryFill
    (already running as PRIMARY) detects fill via REST within 1-15s.
  preconditions:
    - entry market sell order placed (working)
    - KuCoin WS emits fill without clientOrderId
  trigger_sequence:
    - KuCoin WS: orders {clientOrderId: null/absent, orderId: <exchangeOrderId>}
    - byEntryOrderId lookup misses
    - pollForEntryFill: REST getOrder → filled → handleEntryFilled
  expected_behavior:
    - WS fill NOT routed (no order.filled log from WS path)
    - pollForEntryFill detects fill within 1-15s
    - SL+TP placed after poll detects fill
  observability_contract:
    - log: 'order.filled' from REST poll (not WS event)
    - NO error for unrouted KuCoin WS fill event
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (market fill: clientOrderId absent)
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — PRIMARY)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: routine

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_3a.kucoin.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_3a intent is in monitoring on KuCoin. Recovery
    rehydrates IntentState. manager.start() re-arms sl_tp_deadline monitor.
    cancelIgnoreCode=100004 for any orphan cancel calls.
  preconditions:
    - intent in DB with status=monitoring
    - exitOrderRefs.sl and .tp present (resting in KuCoin book)
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor.armed.sl_tp_deadline logged (debug)
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.sl_tp_deadline' (debug)
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated states)
    - src/execution/execution/manager.ts:1888 (re-arm)
    - src/execution/execution/monitor.ts:80 (sl_tp_deadline arm)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_3a.kucoin.SPEC_DIVERGENCE.KUCOIN_POLL_AS_PRIMARY_FILL_PATH
  category: SPEC_DIVERGENCE
  severity: critical
  description: >
    Spec assumes WS fill routing (clientOrderId) is primary. KuCoin market SELL
    fills lack clientOrderId in WS events. pollForEntryFill is PRIMARY for KuCoin
    even for REST-placed market orders. SL+TP placement delayed 1-15s.
  preconditions:
    - strategy_3a intent submitted for kucoin, entry sell fills
  trigger_sequence:
    - KuCoin WS fill: no clientOrderId → not routed
    - pollForEntryFill: REST detects fill within 1-15s
  expected_behavior:
    - SL+TP placed 1-15s after actual fill (brief unprotected window for short)
  observability_contract:
    - log: 'order.filled' from REST poll (NOT WS routing)
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (market fill: no clientOrderId)
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — PRIMARY)
  spec_refs:
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_3a.kucoin.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No KuCoin REST sell order placed.
  preconditions:
    - kill switch mode != 'off', strategy_3a condition for kucoin
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
    - docs-strategy/strategies/strategy_3a.md
  status: ⏳
  natural_occurrence: occasional
```
