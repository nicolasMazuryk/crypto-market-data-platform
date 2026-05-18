# Checklist — okx / strategy_6

Exchange: **okx**
Strategy: **strategy_6** (Post-Funding Directional — WS-Gated Entry)
Spec: `docs-strategy/strategies/strategy_6.md`
Code: `src/execution/strategies/strategy_6.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/okx.ts`

> **Note:** strategy_6 is LIVE-ONLY. No backtest support.
> MAIN and PRE_FUNDING orders use the WS order adapter (requiresWsOrderAdapter('strategy_6')=true).
> OKX strips dashes from clientOrderId via canonicalize() at manager.ts:130.
> OKX funding fee events arrive on 'account.bills' channel with bizType containing "FUND".

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_6.okx.ORDER_LIFECYCLE.PRE_FUNDING_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    At T_f - entryOffsetSeconds (default 10s), manager.submit() is called. A tiny
    market order (preFundingSide = opposite of mainSide, qty = computeMinOrderQty)
    is placed via the WS order adapter. canonicalize() strips dashes from the
    preFundingId before registration in byEntryOrderId and before WS adapter call.
    Pre-funding order subscribes the symbol to the OKX private WS funding-fee stream
    (account.bills channel).
  preconditions:
    - funding_threshold check passed
    - market.status = trading
    - preFundingQty < mainQty
    - kill switch inactive
    - WS order adapter available for okx
  trigger_sequence:
    - scheduler: evaluator fires at entryAt = nextFundingTimestamp - entryOffsetSeconds * 1000
    - manager.submit() → pre_funding_then_main branch
    - canonicalize('okx', preFundingId) → stripped ID registered in byEntryOrderId
    - WS adapter createOrder called with preFundingSide, preFundingVolume
  expected_behavior:
    - intent.created logged (strategy=strategy_6, exchange=okx)
    - intent.submitted logged (entryKind=pre_funding_then_main)
    - order.placed (kind=pre_funding) logged with stripped clientOrderId
    - strategy6.pre_funding_placed logged with qty
    - status transitions decided → submitted → acked → working
    - fundingFeeUnsub listener registered on bus for ws.funding_fee
    - timeoutHandle set for timeoutAt = fundingTs + fundingFeeTimeoutSeconds * 1000
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_6", exchange: "okx"}
    - log: 'intent.submitted' {entryKind: "pre_funding_then_main"}
    - log: 'order.placed' {kind: "pre_funding", side: "sell"|"buy", orderType: "market"}
    - log: 'strategy6.pre_funding_placed' {qty: "<min lot>"}
    - db:orders row {kind: "pre_funding", status: "pending"}
    - db:orders {kind: "pre_funding", intentId: "<id>", exchange: "okx"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:130 (canonicalize — strips dashes for OKX)
    - src/execution/execution/manager.ts:2098 (pre_funding_then_main branch)
    - src/execution/execution/manager.ts:2111 (preFundingId = ids.forIntent(intent.id, 90))
    - src/execution/execution/manager.ts:2334 (preFunding WS createOrder call)
    - src/execution/execution/manager.ts:2367 (order.placed emit for pre_funding)
    - src/execution/execution/manager.ts:2379 (strategy6.pre_funding_placed log)
    - src/execution/execution/manager.ts:91 (requiresWsOrderAdapter — strategy_6 uses WS)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 1)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX pre-funding tiny order uses stripped preFundingId. OKX private WS 'account.bills'
    channel emits funding fee events. The pre-funding order's fill is detected via
    byEntryOrderId lookup using the stripped clOrdId from the 'orders' channel.

- id: strategy_6.okx.ORDER_LIFECYCLE.PRE_FUNDING_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Pre-funding tiny market order fills. OKX 'orders' WS channel emits state=filled
    with clOrdId = stripped preFundingId. Manager routes via byEntryOrderId lookup,
    detects isPreFunding=true, logs strategy6.pre_funding_filled, stores
    preFundingFilledQty. Intent stays in working state awaiting ws.funding_fee.
  preconditions:
    - pre-funding order placed (status=working)
    - OKX 'orders' WS channel active
  trigger_sequence:
    - OKX WS: 'orders' {state: "filled", clOrdId: <stripped-preFundingId>}
  expected_behavior:
    - strategy6.pre_funding_filled logged (filledQty = min lot qty)
    - s.preFundingFilledQty set to order.filledQty
    - intent stays in working state (no transition to monitoring)
    - no SL/TP placed yet
  observability_contract:
    - log: 'strategy6.pre_funding_filled' {filledQty: "<min lot qty>", exchange: "okx"}
    - bus: 'order.filled' {kind: "pre_funding"}
    - db:fills row for pre-funding fill
    - db:intentLifecycleEvents NO transition (stays working)
  code_refs:
    - src/execution/execution/manager.ts:1097 (isPreFunding detection)
    - src/execution/execution/manager.ts:1104 (preFundingFilledQty set)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 1 — pre-funding fill)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX avgPx field carries fill price. OKX clOrdId in 'orders' channel = stripped form.
    The byEntryOrderId map key (stripped preFundingId) must match OKX's clOrdId exactly.

- id: strategy_6.okx.ORDER_LIFECYCLE.FUNDING_FEE_GATES_MAIN_ORDER
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    OKX emits account.bills event with bizType containing "FUND" at T_f. The OKX WS
    adapter maps this to ws.funding_fee on the bus. The bus.on('ws.funding_fee')
    listener in the pre_funding_then_main path checks exchange, symbol, and
    |fundingTime - fundingTs| <= 5000ms. On match, the MAIN order is placed via WS
    adapter. preFundingFilledQty is deducted from mainQty to net the position.
  preconditions:
    - intent in working, pre-funding filled
    - OKX account.bills event received for the correct symbol at T_f
  trigger_sequence:
    - OKX WS: 'account.bills' {bizType: "Funding fee", instId: <symbol>}
    - bus: 'ws.funding_fee' {exchange: "okx", symbol: <normalized>}
    - fundingFeeUnsub fires → MAIN order placement
    - WS adapter createOrder for MAIN (mainSide, mainQty - preFundingFilledQty)
  expected_behavior:
    - ws.funding_fee received and matched
    - strategy6.main_placed logged with qty
    - order.placed (kind=main, side=mainSide, orderType=market) logged
    - timeoutHandle cleared
    - MAIN fill detection starts (WS or pollForEntryFill)
  observability_contract:
    - log: 'strategy6.main_placed' {qty: "<mainQty - preFundingFilledQty>", exchange: "okx"}
    - log: 'order.placed' {kind: "main", side: "buy"|"sell", orderType: "market"}
    - bus: 'ws.funding_fee' {exchange: "okx", symbol: <symbol>}
    - db:orders row {kind: "main", status: "pending"}
  code_refs:
    - src/execution/execution/manager.ts:2204 (bus.on ws.funding_fee in pre_funding path)
    - src/execution/execution/manager.ts:2240 (MAIN order placement via WS adapter)
    - src/execution/execution/manager.ts:2282 (strategy6.main_placed log)
    - src/execution/adapters/privatews/okx.ts (account.bills handler → ws.funding_fee)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 2 — MAIN order after funding event)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX account.bills bizType for funding: "Funding fee" (verify exact string in adapter).
    OKX symbol in bills event is instId format (e.g. BTC-USDT-SWAP) — adapter normalizes
    to BTCUSDT before emitting ws.funding_fee.

- id: strategy_6.okx.ORDER_LIFECYCLE.MAIN_FILLED_AND_SL_TP_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    MAIN market order fills. OKX 'orders' WS emits state=filled with stripped mainId.
    Manager routes via byEntryOrderId, detects isMain=true, logs order.filled, transitions
    to filled. handleEntryFilled (sl_tp_deadline_post_funding_event variant) places SL+TP
    via REST and arms the monitor.
  preconditions:
    - MAIN order placed (after ws.funding_fee match)
    - OKX 'orders' WS active
  trigger_sequence:
    - OKX WS: 'orders' {state: "filled", clOrdId: <stripped-mainId>}
    - handleEntryFilled → SL + TP placed via REST
    - monitor.armed.sl_tp_deadline_post_funding_event logged
  expected_behavior:
    - order.filled logged (mainQty, avgFillPrice)
    - position.opened logged (side=mainSide)
    - SL (stop_market) + TP (limit) placed via REST
    - monitor armed with sl_tp_deadline_post_funding_event policy
  observability_contract:
    - log: 'order.filled' {exchange: "okx", filledQty: ">0"}
    - log: 'position.opened' {side: "buy"|"sell"}
    - log: 'order.placed' {kind: "sl"} and {kind: "tp"}
    - log: 'monitor.armed.sl_tp_deadline_post_funding_event' (debug)
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:595 (handleEntryFilled sl_tp_deadline_post_funding_event)
    - src/execution/execution/manager.ts:784 (monitor.arm + pollForSlTpFill)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 2 — fill → SL+TP)
  status: ⏳
  natural_occurrence: routine

- id: strategy_6.okx.ORDER_LIFECYCLE.FUNDING_FEE_TIMEOUT_FALLBACK
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    ws.funding_fee does not arrive before timeoutAt. Timeout fires. MAIN order is placed
    via WS adapter as a fallback. Remaining flow is the same as the funding-gated path.
  preconditions:
    - pre-funding filled, ws.funding_fee not received before timeoutAt
  trigger_sequence:
    - setTimeout at timeoutAt fires → MAIN order placed (timeout path)
  expected_behavior:
    - strategy6.main_placed_timeout logged (or similar)
    - MAIN order placed via WS adapter
    - flow continues to fill→monitoring
  observability_contract:
    - log: 'strategy6.main_placed_timeout' or similar {exchange: "okx"}
    - log: 'order.placed' {kind: "main"}
    - db:orders row {kind: "main"}
  code_refs:
    - src/execution/execution/manager.ts:2320 (timeout callback in pre_funding path)
    - src/execution/execution/manager.ts:2330 (MAIN placement on timeout)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (Timeout fallback)
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_6.okx.TIMING.PRE_FUNDING_PLACED_AT_CORRECT_OFFSET
  category: TIMING
  severity: high
  description: >
    Pre-funding tiny order placed at T_f - 10s (entryOffsetSeconds=10 for strategy_6).
    OKX WS adapter round-trip typically <100ms. Order must be live in OKX system
    before T_f so the symbol's account.bills funding event is received.
  preconditions:
    - scheduler fires at entryAt = nextFundingTimestamp - 10000ms
  trigger_sequence:
    - evaluate() fires → pre_funding_then_main branch → WS createOrder
  expected_behavior:
    - order.placed (pre_funding) at ≈ entryAt
    - pre-funding fill at ≈ entryAt + <WS latency>
  observability_contract:
    - log: 'order.placed' {kind: "pre_funding"} at ≈ entryAt
    - log: 'strategy6.pre_funding_filled' shortly after
  code_refs:
    - src/execution/strategies/strategy_6.ts (entryAt computation)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (PHASE 1 timing)
  status: ⏳
  natural_occurrence: routine

- id: strategy_6.okx.TIMING.FUNDING_FEE_EVENT_TRIGGERS_MAIN
  category: TIMING
  severity: critical
  description: >
    OKX account.bills funding event arrives at T_f (typically within 0-3s of the funding
    timestamp). The monitor matches within ±5000ms tolerance. MAIN order is placed
    immediately via WS adapter. Latency between ws.funding_fee event and MAIN order.placed
    should be <200ms.
  preconditions:
    - intent in working, pre-funding filled
    - OKX account.bills event arrives within timeoutAt
  trigger_sequence:
    - OKX WS: account.bills funding → bus ws.funding_fee → MAIN order placed
  expected_behavior:
    - MAIN order placed within 200ms of ws.funding_fee bus event
    - monitor.settle latencyMs measurable
  observability_contract:
    - log: 'strategy6.main_placed' within 200ms of ws.funding_fee timestamp
    - log: 'order.placed' {kind: "main"} at ≈ T_f
  code_refs:
    - src/execution/execution/manager.ts:2204 (bus.on ws.funding_fee → MAIN placement)
    - src/execution/adapters/privatews/okx.ts (account.bills → ws.funding_fee)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (MAIN placement at T_f)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX account.bills funding events arrive within 0-5s of T_f. The ±5000ms tolerance
    window in monitor.ts:201 handles OKX clock drift and event delivery delays.

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_6.okx.OCO.SL_FILLS_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    SL stop_market fills for the MAIN position. OKX 'orders' emits state=filled for
    the SL's stripped clientOrderId. Monitor settle('sl'). handleMonitorExit cancels
    TP via cancelSiblingExit. OCO cancel uses stripped IDs.
  preconditions:
    - intent in monitoring, SL and TP resting
    - price hits SL trigger level
  trigger_sequence:
    - OKX WS: 'orders' {state: "filled", clOrdId: <slId stripped>}
    - monitor.settle('sl') → handleMonitorExit
  expected_behavior:
    - monitor.settle {reason: "sl"} logged
    - oco.cancel.start for TP
    - intent.exited.complete {exitReason: "sl"}
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: <tpId stripped>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
  code_refs:
    - src/execution/execution/monitor.ts:124 (ws.order listener for SL fill)
    - src/execution/execution/manager.ts:1502 (cancel tp on sl exit)
    - src/execution/execution/manager.ts:1520 (cancelSiblingExit)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (SL exit)
  status: ⏳
  natural_occurrence: occasional

- id: strategy_6.okx.OCO.TP_FILLS_SL_CANCELED
  category: OCO
  severity: critical
  description: >
    TP limit fills for the MAIN position. OKX 'orders' emits state=filled for TP's
    stripped clientOrderId. Monitor settle('tp'). handleMonitorExit cancels SL.
  preconditions:
    - intent in monitoring, TP resting
    - price hits TP limit level
  trigger_sequence:
    - OKX WS: 'orders' {state: "filled", clOrdId: <tpId stripped>}
    - monitor.settle('tp') → handleMonitorExit
  expected_behavior:
    - monitor.settle {reason: "tp"} logged
    - oco.cancel.start for SL
    - intent.exited.complete {exitReason: "tp"}
  observability_contract:
    - log: 'monitor.settle' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: <slId stripped>}
    - log: 'intent.exited.complete' {exitReason: "tp"}
  code_refs:
    - src/execution/execution/monitor.ts:131 (ws.order listener for TP fill)
    - src/execution/execution/manager.ts:1504 (cancel sl on tp exit)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (TP exit)
  status: ⏳
  natural_occurrence: occasional

- id: strategy_6.okx.OCO.DEADLINE_CANCELS_BOTH
  category: OCO
  severity: critical
  description: >
    Deadline fires (deadlineAt). handleMonitorExit cancels SL and TP, places market
    close (direction depends on mainSide). OKX cancel uses stripped IDs.
  preconditions:
    - intent in monitoring at deadlineAt, neither SL nor TP filled
  trigger_sequence:
    - monitor.settle('deadline') → handleMonitorExit → cancel [sl, tp] → market close
  expected_behavior:
    - oco.cancel.start x2 (sl, tp)
    - order.placed {kind: "close", orderType: "market", reduceOnly: true}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'oco.cancel.start' x2
    - log: 'order.placed' {kind: "close", reduceOnly: true}
    - log: 'intent.exited.complete' {exitReason: "deadline"}
  code_refs:
    - src/execution/execution/manager.ts:1578 (cancel refs loop)
    - src/execution/execution/manager.ts:1660 (market close)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (Deadline exit)
  status: ⏳
  natural_occurrence: occasional

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_6.okx.WEBSOCKET.WS_ADAPTER_REQUIRED_FOR_MAIN
  category: WEBSOCKET
  severity: critical
  description: >
    MAIN order requires WS order adapter (requiresWsOrderAdapter('strategy_6')=true).
    If WS adapter is unavailable or disconnected when MAIN needs to be placed, the
    WS call throws and setError('create_order_failed') is called. No REST fallback
    for MAIN entry (unlike close order which has REST fallback for ws_rejected).
  preconditions:
    - ws.funding_fee or timeout fires, MAIN order should be placed
    - WS order adapter unavailable or throws
  trigger_sequence:
    - MAIN placement via WS adapter → throws
    - catch: setError(s, 'create_order_failed', err.message)
  expected_behavior:
    - intent.error logged with code=create_order_failed
    - pre-funding position still open (no SL/TP placed)
    - manual intervention needed to close pre-funding position
  observability_contract:
    - log: 'intent.error' {code: "create_order_failed"}
    - db:intentLifecycleEvents working→error
    - db:orders no main order row
  code_refs:
    - src/execution/execution/manager.ts:91 (requiresWsOrderAdapter for strategy_6)
    - src/execution/execution/manager.ts:2707 (createOrder catch → setError)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: rare
  notes: >
    Pre-funding position is left open on OKX if MAIN placement fails. This is a residual
    position that recovery will cancel as orphan on next restart. Verify the pre-funding
    order qty is small enough that the residual position risk is acceptable.

- id: strategy_6.okx.WEBSOCKET.RECONNECT_BETWEEN_PRE_AND_MAIN
  category: WEBSOCKET
  severity: high
  description: >
    OKX WS disconnects between pre-funding fill and MAIN order placement. store.reconcile
    called on reconnect. The bus.on('ws.funding_fee') listener is still active (survives
    reconnect). If the funding event arrived during the disconnect, the timeout fallback
    fires at timeoutAt instead.
  preconditions:
    - pre-funding filled, waiting for ws.funding_fee
    - WS disconnects and reconnects
  trigger_sequence:
    - ws.connection {state: "disconnected"}
    - account.bills funding event MISSED during disconnect
    - ws.connection {state: "connected"} → store.reconcile
    - timeout fires at timeoutAt → MAIN order placed via timeout path
  expected_behavior:
    - store.reconcile fetches positions/orders (pre-funding fill confirmed)
    - ws.funding_fee NOT received during disconnect → timeout fires
    - MAIN order placed at timeoutAt via timeout fallback
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal)
    - log: event='ws.connection' {exchange: "okx", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - log: 'strategy6.main_placed_timeout' at timeoutAt (not at T_f)
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/execution/manager.ts:2320 (timeout callback → MAIN placement)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_6.okx.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while strategy_6 intent is in monitoring (MAIN filled, SL/TP
    resting). Recovery rehydrates IntentState. manager.start() re-arms
    sl_tp_deadline_post_funding_event monitor. OKX canonicalize() applied to IDs.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=sl_tp_deadline_post_funding_event
    - exitOrderRefs.sl and .tp present
  trigger_sequence:
    - process restart → runRecovery() → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor re-armed (deadline timer + ws.order listeners for sl/tp)
    - if deadlineAt past: fires immediately
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: ">=1"}
    - log: 'monitor.armed.sl_tp_deadline_post_funding_event' (debug)
  code_refs:
    - src/execution/recovery/index.ts:132 (canonicalize for OKX)
    - src/execution/recovery/index.ts:245 (rehydrated states log)
    - src/execution/execution/manager.ts:1888 (start — re-arm)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_6.okx.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PRE_FUNDING
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active at submit time. Preflight rejects with code=kill_switch.
    No pre-funding order placed, no WS adapter call.
  preconditions:
    - kill switch mode != 'off'
    - strategy_6 condition met for okx
  trigger_sequence:
    - manager.submit() → preflight → killSwitch.canPlaceOrder() returns false
  expected_behavior:
    - intent.error logged with code=kill_switch
    - no order.placed
  observability_contract:
    - log: 'intent.error' {code: "kill_switch"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:intentLifecycleEvents decided→error
  code_refs:
    - src/execution/execution/preflight.ts:32 (kill switch check)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_6.okx.SPEC_DIVERGENCE.OKX_ACCOUNT_BILLS_FUNDING_SIGNAL
  category: SPEC_DIVERGENCE
  severity: medium
  description: >
    The spec describes a generic 'ws.funding_fee' event to gate the MAIN order.
    On OKX, this event arrives on the 'account.bills' WS channel with bizType
    containing "FUND" (e.g., "Funding fee"). The OKX WS adapter maps this to
    ws.funding_fee on the internal bus. OKX account.bills events may lag T_f
    by 0-5 seconds.
  preconditions:
    - OKX account.bills channel subscribed
    - T_f arrives
  trigger_sequence:
    - OKX WS: account.bills {bizType: "Funding fee", instId: <symbol>}
    - OKX adapter → bus.emit('ws.funding_fee', {exchange: "okx", ...})
  expected_behavior:
    - ws.funding_fee bus event emitted within ±5s of T_f
    - MAIN order triggered correctly
  observability_contract:
    - bus: 'ws.funding_fee' {exchange: "okx"} within 5s of T_f
    - log: 'strategy6.main_placed' shortly after
  code_refs:
    - src/execution/adapters/privatews/okx.ts (account.bills → ws.funding_fee)
  spec_refs:
    - docs-strategy/strategies/strategy_6.md (ws.funding_fee trigger)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Verify the exact OKX bizType string in the adapter. OKX may use localized or
    versioned strings. The 5s tolerance in monitor.ts:201 handles OKX delivery lag.
```
