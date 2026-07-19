# Checklist — kucoin / strategy_6

Exchange: **kucoin**
Strategy: **strategy_6** (Pre-Funding then Main — sl_tp_deadline_post_funding_event)
Spec: `docs-strategy/strategies/strategy_6.md`
Code: `src/execution/strategies/strategy_6.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/kucoin.ts`

---

**KuCoin-specific notes (CRITICAL):**

- WS entry via WS order adapter (requiresWsOrderAdapter=true) for pre-funding market buy
- KuCoin does NOT echo `clientOrderId` for market fills in WS events → `pollForEntryFill` is PRIMARY fill path
- `wallet.funding` WS channel gates MAIN entry (fundingEventReceived=true)
- `cancelIgnoreCode: 100004` (order not found = success) for OCO cancels
- ms timestamps throughout
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_6.kucoin.ORDER_LIFECYCLE.PRE_FUNDING_ENTRY_VIA_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. PRE-FUNDING market BUY placed
    via WS order adapter. No clientOrderId transformation on KuCoin. pollForEntryFill
    started immediately as PRIMARY fill detection (KuCoin market fills lack clientOrderId
    in WS events). wallet.funding listener registered to gate MAIN entry.
  preconditions:
    - strategy_6 condition met (funding rate threshold)
    - WS order adapter available for kucoin
  trigger_sequence:
    - scheduler fires → manager.submit() → WS adapter createOrder (buy, market)
    - pollForEntryFill started (PRIMARY)
    - wallet.funding listener registered
  expected_behavior:
    - intent.created logged (strategy=strategy_6, exchange=kucoin)
    - order.placed {kind: "pre_funding", side: "sell"|"buy", orderType: "market"} logged
    - pollForEntryFill running (PRIMARY)
    - status decided → submitted → acked → working
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_6", exchange: "kucoin"}
    - log: 'order.placed' {kind: "pre_funding", side: "sell"|"buy", orderType: "market"}
    - db:orders {kind: "pre_funding", intentId: "<id>", exchange: "kucoin"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:90 (requiresWsOrderAdapter)
    - src/execution/execution/manager.ts:2787 (pollForEntryFill — PRIMARY)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    KuCoin WS market fills lack clientOrderId → pollForEntryFill (15×1s REST) is PRIMARY.

- id: strategy_6.kucoin.ORDER_LIFECYCLE.PRE_FUNDING_FILLED_REST_POLL
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    PRIMARY fill detection for pre-funding entry on KuCoin. pollForEntryFill (15×1s)
    detects fill. position.pre_funding_opened logged. Strategy waits for wallet.funding
    event to gate MAIN entry. No SL placed yet.
  preconditions:
    - pre-funding entry order placed (working), KuCoin REST accessible
  trigger_sequence:
    - pollForEntryFill: getOrder(exchangeOrderId) returns status=filled
    - position.pre_funding_opened → wait for wallet.funding
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice from REST)
    - position.pre_funding_opened logged
    - strategy waits for wallet.funding event
    - TERMINAL guard prevents double-processing
  observability_contract:
    - log: 'order.filled' {exchange: "kucoin", filledQty: ">0"}
    - log: 'position.pre_funding_opened'
    - db:intentLifecycleEvents filled→waiting_for_funding
  code_refs:
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — PRIMARY)
    - src/execution/strategies/strategy_6.ts (pre_funding_opened handler)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_6.kucoin.ORDER_LIFECYCLE.MAIN_ENTRY_AFTER_WALLET_FUNDING
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    wallet.funding event received at T_f. fundingEventReceived=true. MAIN market
    BUY placed via WS adapter (additional position). pollForEntryFill started for MAIN.
    SL + TP placed after MAIN fill detected. monitor.armed.sl_tp_deadline_post_funding_event.
  preconditions:
    - pre-funding fill detected, waiting for wallet.funding event
  trigger_sequence:
    - KuCoin WS: wallet.funding {contract: <symbol>} → fundingEventReceived=true
    - MAIN market buy via WS adapter
    - pollForEntryFill for MAIN (PRIMARY — market order on KuCoin)
  expected_behavior:
    - order.placed {kind: "main", side: "buy"|"sell", orderType: "market"} logged
    - MAIN fill detected via REST poll within 1-15s
    - SL (stop_market, sell) + TP (limit, sell) placed
    - monitor.armed.sl_tp_deadline_post_funding_event logged
  observability_contract:
    - log: 'order.placed' {kind: "main", side: "buy"|"sell"}
    - log: 'order.filled' (main fill from REST poll)
    - log: 'order.placed' {kind: "sl"} and {kind: "tp"}
    - log: 'monitor.armed.sl_tp_deadline_post_funding_event' (debug)
    - db:intentLifecycleEvents →monitoring
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (wallet.funding handler)
    - src/execution/strategies/strategy_6.ts (fundingEventReceived gate)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_6.kucoin.ORDER_LIFECYCLE.SL_FILLS_TP_CANCELED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    SL stop_market fills (long position). KuCoin WS 'orders' emits fill for SL
    with clientOrderId (stop orders echo clientOrderId). monitor.settle('sl').
    handleMonitorExit cancels TP (100004 OK).
  preconditions:
    - intent in monitoring, price drops to SL stop price
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
  code_refs:
    - src/execution/execution/monitor.ts:124 (ws.order SL listener)
    - src/execution/execution/manager.ts:1502 (cancel tp on sl)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_6.kucoin.ORDER_LIFECYCLE.TP_FILLS_SL_CANCELED
  category: OCO
  severity: critical
  description: >
    TP limit fills. KuCoin WS 'orders' emits fill for TP with clientOrderId.
    monitor.settle('tp'). handleMonitorExit cancels SL (100004 OK).
  preconditions:
    - intent in monitoring, TP resting, price rises to TP level
  trigger_sequence:
    - KuCoin WS: orders {status: "filled", clientOrderId: <tpId>}
    - monitor.settle('tp') → cancel SL (100004 OK)
  expected_behavior:
    - monitor.settle {reason: "tp"}
    - oco.cancel.start for SL (100004 = success)
    - intent.exited.complete {exitReason: "tp"}
  observability_contract:
    - log: 'monitor.settle' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: <slId>}
    - log: 'intent.exited.complete' {exitReason: "tp"}
  code_refs:
    - src/execution/execution/monitor.ts:131 (ws.order TP listener)
    - src/execution/execution/manager.ts:1504 (cancel sl on tp)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_6.kucoin.TIMING.WALLET_FUNDING_GATES_MAIN_ENTRY
  category: TIMING
  severity: critical
  description: >
    At T_f, KuCoin emits wallet.funding WS event. Adapter maps to internal bus.
    fundingEventReceived=true. MAIN market buy placed immediately. This is the
    critical timing path — MAIN entry should fire ≤1s after T_f.
  preconditions:
    - pre-funding fill detected (polling done), waiting for wallet.funding
  trigger_sequence:
    - KuCoin WS: wallet.funding {contract: <symbol>}
    - fundingEventReceived=true → MAIN buy via WS adapter
  expected_behavior:
    - MAIN entry placed within ms of wallet.funding event
  observability_contract:
    - log: 'order.placed' {kind: "main"} timestamp ≈ wallet.funding timestamp
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (wallet.funding handler)
    - src/execution/strategies/strategy_6.ts (fundingEventReceived gate)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_6.kucoin.TIMING.DEADLINE_FIRES_CANCEL_BOTH
  category: TIMING
  severity: high
  description: >
    Neither SL nor TP fills before deadlineAt. Deadline fires. SL and TP cancelled
    (100004 OK). Market close sell (reduceOnly) placed.
  preconditions:
    - intent in monitoring, neither SL nor TP filled before deadline
  trigger_sequence:
    - monitor.settle('deadline') → cancel [sl, tp] (100004 OK) → market sell close
  expected_behavior:
    - oco.cancel.start x2 (100004 = success)
    - order.placed {kind: "close", side: "sell", reduceOnly: true}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'monitor.settle' {reason: "deadline"}
    - log: 'oco.cancel.start' x2
    - log: 'order.placed' {kind: "close"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:115 (deadline timer)
    - src/execution/execution/manager.ts:1660 (market close)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_6.kucoin.WEBSOCKET.KUCOIN_MARKET_FILL_NO_CLIENT_ORDER_ID
  category: WEBSOCKET
  severity: critical
  description: >
    KuCoin WS 'orders' channel emits fill for the pre-funding market buy WITHOUT
    clientOrderId. byEntryOrderId lookup FAILS silently. pollForEntryFill (PRIMARY)
    detects fill via REST within 1-15s. MAIN entry is delayed until pre-funding fill
    confirmed AND wallet.funding received.
  preconditions:
    - pre-funding market buy placed via WS (working)
    - KuCoin WS emits fill without clientOrderId
  trigger_sequence:
    - KuCoin WS: orders {clientOrderId: null/absent}
    - byEntryOrderId lookup misses
    - pollForEntryFill: REST getOrder → filled → position.pre_funding_opened
  expected_behavior:
    - WS fill NOT routed (no order.filled from WS path)
    - pollForEntryFill detects fill within 1-15s
    - MAIN entry fires only after both: pre-funding fill confirmed AND wallet.funding
  observability_contract:
    - log: 'order.filled' from REST poll (not WS event)
    - NO error for unrouted KuCoin WS fill event
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (market fill: clientOrderId absent)
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — PRIMARY)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_6.kucoin.WEBSOCKET.RECONNECT_BETWEEN_PRE_AND_MAIN
  category: WEBSOCKET
  severity: high
  description: >
    KuCoin WS disconnects after pre-funding fill detected but before wallet.funding event.
    On reconnect, store.reconcile called. wallet.funding listener must be re-registered.
    If wallet.funding event was missed during disconnect, MAIN entry may not fire.
  preconditions:
    - pre-funding fill confirmed, waiting for wallet.funding
    - KuCoin WS disconnects and reconnects
  trigger_sequence:
    - ws.connection {state: "connected"} → store.reconcile('kucoin')
    - wallet.funding listener re-registered on reconnect
  expected_behavior:
    - reconcile fetches positions (pre-funding position visible)
    - wallet.funding listener active on new connection
    - if wallet.funding already missed: timeout/deadline fallback
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal)
    - log: event='ws.connection' {exchange: "kucoin", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - position visible after reconcile
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: rare

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_6.kucoin.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_6 intent is in monitoring on KuCoin (both
    pre-funding and MAIN fills complete, SL + TP resting). Recovery rehydrates
    IntentState. manager.start() re-arms sl_tp_deadline_post_funding_event monitor.
    cancelIgnoreCode=100004 for orphan cancel calls.
  preconditions:
    - intent in DB with status=monitoring
    - SL and TP resting in KuCoin book
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor.armed.sl_tp_deadline_post_funding_event logged (debug)
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed' (debug)
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated states)
    - src/execution/execution/manager.ts:1888 (re-arm)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_6.kucoin.SPEC_DIVERGENCE.KUCOIN_POLL_AS_PRIMARY_FILL_PATH
  category: SPEC_DIVERGENCE
  severity: critical
  description: >
    Both pre-funding and MAIN entries are market orders on KuCoin. KuCoin market
    fills lack clientOrderId in WS events → pollForEntryFill is PRIMARY for both.
    Pre-funding fill detection latency 1-15s delays the total strategy timeline.
  preconditions:
    - strategy_6 intent submitted for kucoin, pre-funding entry fills
  trigger_sequence:
    - KuCoin WS fill: no clientOrderId → not routed
    - pollForEntryFill: REST detects fill within 1-15s
  expected_behavior:
    - pre-funding fill detected 1-15s after actual fill
    - MAIN entry fires 1-15s later than on other exchanges
  observability_contract:
    - log: 'order.filled' from REST poll (NOT WS routing)
    - no error for unrouted KuCoin WS fill events
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (market fill: no clientOrderId)
    - src/execution/execution/manager.ts:1179 (pollForEntryFill — PRIMARY)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_6.kucoin.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No KuCoin WS call for pre-funding entry.
  preconditions:
    - kill switch mode != 'off', strategy_6 condition for kucoin
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
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional
```
