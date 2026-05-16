# Checklist — okx / strategy_1

Exchange: **okx**
Strategy: **strategy_1** (Negative Funding LONG — Instant Exit)
Spec: `docs-strategy/strategies/strategy_1.md`
Code: `src/execution/strategies/strategy_1.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_1.okx.ORDER_LIFECYCLE.ENTRY_FILLED_WS
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Entry market order fills. OKX emits an event on the 'orders' WS channel with
    state=filled. Manager routes via byEntryOrderId using the stripped clientOrderId
    (clOrdId field in OKX WS, which carries the dash-stripped form).
  preconditions:
    - entry order placed (status=working)
    - OKX private WS 'orders' channel subscribed
  trigger_sequence:
    - OKX WS: orders channel {state: "filled", clOrdId: <stripped-clientOrderId>}
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice)
    - status transitions working → filled → monitoring
    - position.opened logged (side=long)
    - monitor.armed.timed (debug)
    - no SL/TP placed
  observability_contract:
    - log: 'order.filled' {exchange: "okx", filledQty: ">0"}
    - log: 'position.opened' {side: "long"}
    - log: 'monitor.armed.timed' {delay: "~7000ms"}
    - db:orders {kind: "entry", status: "filled"}
    - db:intentLifecycleEvents filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:1898 (ws.order handler)
    - src/execution/execution/manager.ts:1136 (FILLED branch)
    - src/execution/execution/manager.ts:773 (position.opened)
    - src/execution/execution/manager.ts:784 (transition monitoring, monitor.arm)
    - src/execution/execution/monitor.ts:97 (timed arm)
    - src/execution/adapters/privatews/okx.ts (orders channel parser)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (Execution Flow step 1)
  status: ⏳
  natural_occurrence: routine
  notes: >
    OKX 'orders' channel carries clOrdId with the canonical (dash-stripped) form.
    byEntryExchangeOrderId (ordId field) is also registered as fallback. Fills on
    OKX market orders are generally immediate and arrive via WS before the REST poll.

- id: strategy_1.okx.ORDER_LIFECYCLE.ENTRY_PARTIAL_THEN_FULL_FILL
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Entry market order partially fills then fully fills. OKX WS emits partial_fill
    then filled state on the orders channel.
  preconditions:
    - entry order in status=working
    - OKX emits partial then full fill events
  trigger_sequence:
    - OKX WS: orders channel {state: "partially_filled"}
    - OKX WS: orders channel {state: "filled"}
  expected_behavior:
    - status transitions working → partially_filled → filled
    - order.filled logged once on filled event
    - position.opened logged
    - monitor armed
  observability_contract:
    - db:intentLifecycleEvents working→partially_filled→filled
    - log: 'order.filled' (on final fill)
    - log: 'position.opened' {side: "long"}
  code_refs:
    - src/execution/execution/manager.ts:1159 (partially_filled transition)
    - src/execution/execution/manager.ts:1136 (FILLED branch)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (Execution Flow step 1)
  status: ⏳
  natural_occurrence: occasional
  notes: OKX market orders rarely partial-fill but can in low-liquidity symbols.

- id: strategy_1.okx.ORDER_LIFECYCLE.ENTRY_REJECTED_INSUFFICIENT_BALANCE
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Preflight check fires; available USDT < required margin. Intent errors with
    code=insufficient_balance before any order reaches OKX.
  preconditions:
    - available USDT < amountUsd / leverage
  trigger_sequence:
    - manager.submit() → preflight balance check fails
  expected_behavior:
    - intent.error logged with code=insufficient_balance
    - no order.placed
    - status decided → error
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_1", exchange: "okx"}
    - log: 'intent.error' {code: "insufficient_balance"}
    - db:intentLifecycleEvents decided→error
    - db:orders no entry for this intentId
  code_refs:
    - src/execution/execution/preflight.ts:77 (balance check)
    - src/execution/execution/manager.ts:2044 (preflight call)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    OKX REST error code for insufficient margin is 51008. Preflight runs first so
    the OKX error code is never seen in normal flow.

- id: strategy_1.okx.ORDER_LIFECYCLE.ENTRY_CREATE_ORDER_FAILED
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    REST createOrder throws (network error, OKX returns rate-limit error 50011 or similar).
    Manager catches, errors with code=create_order_failed.
  preconditions:
    - preflight passes
    - REST call to OKX createOrder throws
  trigger_sequence:
    - rest.createOrder() rejects
  expected_behavior:
    - intent.error logged with code=create_order_failed
    - status submitted → error
    - byEntryOrderId entry removed
  observability_contract:
    - log: 'intent.error' {code: "create_order_failed", exchange: "okx"}
    - db:intentLifecycleEvents submitted→error
  code_refs:
    - src/execution/execution/manager.ts:2707 (createOrder catch)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: occasional
  notes: OKX rate-limit code is 50011. Will appear inside the exception message.

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_1.okx.TIMING.ENTRY_FILL_REST_POLL_FALLBACK
  category: TIMING
  severity: high
  description: >
    WS fill event for entry order not received. REST poll (pollForEntryFill,
    15×1s) detects fill via getOrder. OKX WS fills are generally reliable so
    this is a safety net, not the primary path.
  preconditions:
    - entry order placed (status=working)
    - WS fill event not received
  trigger_sequence:
    - pollForEntryFill loop: getOrder returns status=filled
  expected_behavior:
    - order.filled logged (from poll path)
    - status working → filled → monitoring
  observability_contract:
    - log: 'order.filled' (emitted from handleEntryOrderEvent called by poll)
    - log: 'position.opened'
    - db:intentLifecycleEvents working→filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:1179 (pollForEntryFill)
    - src/execution/execution/manager.ts:2787 (poll started)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: occasional
  notes: OKX orders channel is generally reliable. Poll is the fallback.

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_1.okx.WEBSOCKET.RECONNECT_TRIGGERS_RECONCILE
  category: WEBSOCKET
  severity: high
  description: >
    OKX private WS disconnects and reconnects while intent is in monitoring.
    State store detects ws.connection→connected and calls store.reconcile().
  preconditions:
    - intent in monitoring
    - WS disconnects then reconnects
  trigger_sequence:
    - ws.connection {state: "disconnected"}
    - ws.connection {state: "connected"}
  expected_behavior:
    - store.reconcile() called → REST getOpenOrders + getPositions fetched
    - timed monitor NOT re-armed (continues from original exitAt)
    - no duplicate exit
  observability_contract:
    - bus: 'ws.connection' {state: "connected"}
    - log: event='ws.connection' {exchange: "okx", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - log: 'store.reconcile.complete' {durationMs, desyncCount} (INFO)
    - REST activity: getOpenOrders + getPositions calls
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (no WS behavior in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: Reconcile logs store.reconcile.complete at INFO with durationMs + desyncCount.

- id: strategy_1.okx.WEBSOCKET.FUNDING_FEE_EVENT_RECEIVED
  category: WEBSOCKET
  severity: medium
  description: >
    At T_f, OKX emits a funding fee on the 'account' channel (bills array, bizType
    contains "FUND"). This is parsed as ws.funding_fee. For strategy_1 (exitPolicy=timed),
    the monitor ignores it. Intent stays in monitoring until timed exit fires at T_f+2s.
  preconditions:
    - intent in monitoring
    - funding settlement at T_f
  trigger_sequence:
    - OKX WS: account channel {bills: [{bizType: "Funding fee", ...}]}
  expected_behavior:
    - ws.funding_fee bus event emitted (no logger.info)
    - monitor does NOT settle (timed policy ignores funding_fee events)
    - timed exit fires ~2s later
  observability_contract:
    - bus: 'ws.funding_fee' {exchange: "okx", symbol} (no log)
    - db:fundingAttributions row inserted
    - log: 'monitor.settle' {reason: "timed"} fires ~2s after funding event
    - NO 'monitor.settle' {reason: "funding_fee"}
  code_refs:
    - src/execution/adapters/privatews/okx.ts (account channel parser)
    - src/execution/execution/monitor.ts:97 (timed branch — funding_fee bus ignored)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: routine
  notes: OKX bills array may contain multiple entries; filter by bizType for FUND entries.

- id: strategy_1.okx.WEBSOCKET.CLOSE_FILL_REST_POLL_FALLBACK
  category: WEBSOCKET
  severity: high
  description: >
    WS fill event for close order not received. pollForCloseFill (20×1s) detects
    fill via getOrder or position=flat. Logs 'intent.exited.complete' (REST poll path).
  preconditions:
    - intent in exiting
    - close order placed
    - WS fill event missed
  trigger_sequence:
    - pollForCloseFill: getOrder returns filled OR position qty=0
  expected_behavior:
    - intent.exited.complete logged (REST poll path only)
    - status exiting → exited
  observability_contract:
    - log: 'intent.exited.complete' {exitReason: "timed"}
    - db:intentLifecycleEvents exiting→exited
  code_refs:
    - src/execution/execution/manager.ts:1235 (pollForCloseFill)
    - src/execution/execution/manager.ts:1255 (exited.complete log)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Distinguishing signal: 'intent.exited.complete' appears only on REST poll path.
    WS close fill handler at manager.ts:1914 does NOT emit this log.

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_1.okx.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarted while intent is in monitoring (timed exit pending). Recovery
    rehydrates IntentState from DB (restoring canonical stripped clientOrderId keys).
    manager.start() re-arms the monitor timer. Timed exit fires at original exitAt.
  preconditions:
    - intent in DB with status=monitoring
    - exitAt in the future
  trigger_sequence:
    - process restart → runRecovery → manager.start()
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor.armed.timed logged
    - timed exit fires and close order placed
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: "≥1"}
    - log: 'monitor.armed.timed'
    - log: 'intent.exiting.start' {reason: "timed"}
  code_refs:
    - src/execution/recovery/index.ts:87 (runRecovery)
    - src/execution/recovery/index.ts:132 (canonicalize applied for OKX stripped IDs)
    - src/execution/recovery/index.ts:245 (rehydrated log)
    - src/execution/execution/manager.ts:1888 (start — re-arm)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (no recovery in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    OKX: canonicalize() is applied in recovery (recovery.ts:132) to ensure
    byEntryOrderId keys use the stripped clientOrderId form, matching WS events.

- id: strategy_1.okx.RECOVERY.RESTART_ORPHAN_CANCEL
  category: RECOVERY
  severity: high
  description: >
    Process restarted; OKX has an open entry order not in DB rehydrated set.
    Recovery cancels it as an orphan.
  preconditions:
    - OKX open order not in DB rehydrated set
  trigger_sequence:
    - runRecovery: getOpenOrders returns order not in rehydratedClientOrderIds
  expected_behavior:
    - 'recovery: orphan order found, cancelling' logged
    - cancelOrder called
  observability_contract:
    - log: 'recovery: orphan order found, cancelling' {exchange: "okx"}
  code_refs:
    - src/execution/recovery/index.ts:271 (orphan cancel loop)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md
  status: ⏳
  natural_occurrence: rare
  notes: OKX clientOrderId in recovery uses stripped form; cancel by clientOrderId works.

# ── STRATEGY_SPECIFIC ────────────────────────────────────────────────────────

- id: strategy_1.okx.STRATEGY_SPECIFIC.LEVERAGE_SET_ONCE
  category: STRATEGY_SPECIFIC
  severity: medium
  description: >
    setLeverage called once per (exchange, symbol, leverage) triple. Cached for
    process lifetime. Subsequent intents on same symbol skip the REST call.
  preconditions:
    - first intent on symbol X
  trigger_sequence:
    - manager.submit() for symbol X first time; second time (same leverage)
  expected_behavior:
    - first: setLeverage REST call made
    - second: skipped (cache hit)
  observability_contract:
    - no duplicate setLeverage calls for same key
    - db:orders second intent shows no extra latency
  code_refs:
    - src/execution/execution/manager.ts:134 (ensureLeverage)
    - src/execution/execution/manager.ts:2067 (ensureLeverage call)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (leverage parameter)
  status: ⏳
  natural_occurrence: routine
  notes: OKX setLeverage is per-symbol; leverage must match what's configured in margin mode.

- id: strategy_1.okx.STRATEGY_SPECIFIC.NEGATIVE_FUNDING_THRESHOLD_FILTER
  category: STRATEGY_SPECIFIC
  severity: medium
  description: >
    strategy_1.evaluate() returns [] when fundingRatePercent >= -threshold.
    No intent created — verified by absence of intent.created log.
  preconditions:
    - fundingRatePercent >= -negativeFundingThresholdPercent
  trigger_sequence:
    - scheduler fires evaluate() with non-qualifying funding event
  expected_behavior:
    - evaluate() returns []
    - no intent.created log
  observability_contract:
    - db:trade_intents no row for this symbol/timestamp
    - no log: 'intent.created' for this event
  code_refs:
    - src/execution/strategies/strategy_1.ts:21 (threshold check)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (F_threshold = 0.4%)
  status: ⏳
  natural_occurrence: routine
  notes: Most funding events on OKX won't meet the threshold.

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_1.okx.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_PREFLIGHT
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active blocks entry before any REST call.
    Spec has no mention of kill switch.
  preconditions:
    - kill switch mode != 'off'
  trigger_sequence:
    - manager.submit() → preflight → killSwitch.canPlaceOrder() returns false
  expected_behavior:
    - intent.error {code: "kill_switch"}
    - no order.placed
  observability_contract:
    - log: 'intent.error' {code: "kill_switch", exchange: "okx"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:intentLifecycleEvents decided→error
  code_refs:
    - src/execution/execution/preflight.ts:32 (kill switch check)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (no kill switch in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: Undocumented behavior — applies to all strategies/exchanges.

- id: strategy_1.okx.SPEC_DIVERGENCE.NO_REF_PRICE_EARLY_REJECT
  category: SPEC_DIVERGENCE
  severity: medium
  description: >
    manager.submit() finds no ref price for the symbol → errors with no_ref_price
    before any order reaches OKX.
  preconditions:
    - refPrice returns undefined for symbol at submit time
  trigger_sequence:
    - manager.submit() → refPrice undefined check
  expected_behavior:
    - intent.error {code: "no_ref_price"}
    - no order.placed
  observability_contract:
    - log: 'intent.error' {code: "no_ref_price", exchange: "okx"}
    - db:intentLifecycleEvents decided→error
  code_refs:
    - src/execution/execution/manager.ts:2012 (price undefined check)
  spec_refs:
    - docs-strategy/strategies/strategy_1.md (assumes price available)
  status: ⏳
  natural_occurrence: rare
  notes: Would occur if OKX price feed WS is disconnected with no cached price.
```
