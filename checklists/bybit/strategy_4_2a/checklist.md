# Checklist — bybit / strategy_4_2a

Exchange: **bybit**
Strategy: **strategy_4_2a** (Negative Funding Single Limit LONG — Post-Funding Entry)
Spec: `docs-strategy/strategies/strategy_4_2.md`
Code: `src/execution/strategies/strategy_4_2a.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`, `src/execution/adapters/privatews/bybit.ts`

---

**Bybit-specific notes (CRITICAL):**
- REST limit entry (no WS adapter)
- Bybit WS event timestamps in **microseconds (μs)** → adapter divides by 1000 for ms
- Bybit echoes `clientOrderId` for limit fills → WS routing works
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_4_2a.bybit.ORDER_LIFECYCLE.LIMIT_ENTRY_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. A limit BUY order is placed via
    REST createOrder at price P_current × (1 - priceOffsetPct/100). No clientOrderId
    transformation for Bybit. Expiry timer armed at deadlineAt. pollForEntryFill started
    as backup (Bybit WS routing primary for limit fills).
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - refPrice available
  trigger_sequence:
    - scheduler fires at entryAt → manager.submit() → limit entry branch → REST createOrder
  expected_behavior:
    - intent.created logged (strategy=strategy_4_2a, exchange=bybit)
    - order.placed (limit) logged with limitPrice
    - status decided → submitted → acked → working
    - expiry timer set at deadlineAt
    - pollForEntryFill started (backup)
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_4_2a", exchange: "bybit"}
    - log: 'order.placed (limit)' {intentId, limitPrice, qty}
    - db:orders {kind: "entry", orderType: "limit", status: "pending"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:2546 (limit entry path)
    - src/execution/execution/manager.ts:2619 (order.placed (limit) log)
    - src/execution/execution/manager.ts:2625 (expiry timer)
    - src/execution/execution/manager.ts:2649 (pollForEntryFill start)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_4_2a.bybit.ORDER_LIFECYCLE.LIMIT_FILLS_AFTER_FUNDING
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    After T_f, price drops to limit level. Bybit WS 'order' channel emits fill
    (μs timestamp, adapter ÷1000, clientOrderId echoed). Manager routes via
    byEntryOrderId, logs order.filled, transitions to filled. handleEntryFilled
    places SL + TP and arms sl_tp_deadline monitor. pollForSlTpFill started.
  preconditions:
    - limit order in status=working, Bybit WS connected, price drops post-funding
  trigger_sequence:
    - Bybit WS: order {orderStatus: "Filled", clientOrderId: <id>, updatedTime: <μs>}
    - adapter: updatedTime / 1000 → ms
    - byEntryOrderId lookup → handleEntryFilled
  expected_behavior:
    - order.filled logged (avgFillPrice = limit price, ms timestamps)
    - position.opened logged (side=long)
    - SL (stop_market, sell) + TP (limit, sell) placed via REST
    - monitor.armed.sl_tp_deadline logged (debug)
    - db:fills createdAt in ms range
  observability_contract:
    - log: 'order.filled' {exchange: "bybit", avgFillPrice: "<limitPrice>"}
    - log: 'position.opened' {side: "long"}
    - log: 'order.placed' {kind: "sl"} and {kind: "tp"}
    - log: 'monitor.armed.sl_tp_deadline' (debug)
    - db:fills createdAt > 1700000000000 AND < 2000000000000
    - db:intentLifecycleEvents working→filled→monitoring
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
    - src/execution/execution/manager.ts:1140 (handleEntryOrderEvent fill branch)
    - src/execution/execution/manager.ts:406 (handleEntryFilled sl_tp_deadline)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_4_2a.bybit.ORDER_LIFECYCLE.LIMIT_EXPIRES_UNFILLED
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Expiry timer fires at deadlineAt without the limit order having filled. cancelOrder
    called on Bybit. setError('limit_order_expired'). Intent errors.
  preconditions:
    - limit in working, unfilled, clock.now() >= deadlineAt
  trigger_sequence:
    - expiry setTimeout fires → cancelOrder → setError('limit_order_expired')
  expected_behavior:
    - 'limit.order_expired' warn logged
    - intent.error {code: "limit_order_expired"}
    - db:intentLifecycleEvents working→error
  observability_contract:
    - log: 'limit.order_expired' {intentId}
    - log: 'intent.error' {code: "limit_order_expired"}
    - db:intentLifecycleEvents working→error
  code_refs:
    - src/execution/execution/manager.ts:2625 (expiry timer)
    - src/execution/execution/manager.ts:2635 (cancelOrder + setError)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_4_2a.bybit.TIMING.DEADLINE_FIRES_IF_FILLED
  category: TIMING
  severity: critical
  description: >
    If limit filled and monitoring active, deadline fires at deadlineAt. SL and TP
    cancelled, market close placed.
  preconditions:
    - intent in monitoring, neither SL nor TP filled before deadlineAt
  trigger_sequence:
    - monitor.settle('deadline') → cancel [sl, tp] → market close
  expected_behavior:
    - oco.cancel.start for SL and TP
    - order.placed {kind: "close", side: "sell", reduceOnly: true}
    - intent.exited.complete {exitReason: "deadline"}
  observability_contract:
    - log: 'monitor.deadline_fired'
    - log: 'order.placed' {kind: "close"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:115 (deadline timer)
    - src/execution/execution/manager.ts:1578 (cancel refs)
    - src/execution/execution/manager.ts:1660 (market close)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: routine

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_4_2a.bybit.OCO.SL_FILLS_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    SL stop_market (sell) fills (long). Bybit WS fill for SL (μs, ÷1000). monitor.settle('sl').
    handleMonitorExit cancels TP.
  preconditions:
    - intent in monitoring, SL and TP resting, price drops below SL stop
  trigger_sequence:
    - Bybit WS: order {clientOrderId: <slId>, orderStatus: "Filled", updatedTime: <μs>}
    - monitor.settle('sl') → cancel TP
  expected_behavior:
    - monitor.settle {reason: "sl"}
    - oco.cancel.start for TP
    - intent.exited.complete {exitReason: "sl"}
    - db:fills SL createdAt in ms range
  observability_contract:
    - log: 'monitor.settle' {reason: "sl"}
    - log: 'oco.cancel.start' {clientOrderId: <tpId>}
    - log: 'intent.exited.complete' {exitReason: "sl"}
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
    - src/execution/execution/monitor.ts:124 (ws.order SL listener)
    - src/execution/execution/manager.ts:1502 (cancel tp on sl)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_4_2a.bybit.OCO.TP_FILLS_SL_CANCELED
  category: OCO
  severity: critical
  description: >
    TP limit (sell) fills for the long. Bybit WS fill for TP (μs, ÷1000). monitor.settle('tp').
    handleMonitorExit cancels SL.
  preconditions:
    - intent in monitoring, TP resting, price rises to TP level
  trigger_sequence:
    - Bybit WS: order {clientOrderId: <tpId>, orderStatus: "Filled", updatedTime: <μs>}
    - monitor.settle('tp') → cancel SL
  expected_behavior:
    - monitor.settle {reason: "tp"}
    - oco.cancel.start for SL
    - intent.exited.complete {exitReason: "tp"}
    - db:fills TP createdAt in ms range
  observability_contract:
    - log: 'monitor.settle' {reason: "tp"}
    - log: 'oco.cancel.start' {clientOrderId: <slId>}
    - log: 'intent.exited.complete' {exitReason: "tp"}
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
    - src/execution/execution/monitor.ts:131 (ws.order TP listener)
    - src/execution/execution/manager.ts:1504 (cancel sl on tp)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: occasional

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_4_2a.bybit.RECOVERY.RESTART_WHILE_LIMIT_RESTING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while limit order is resting in Bybit book (status=working).
    Recovery sees resting limit as orphan and cancels it. Intent errors.
  preconditions:
    - intent in DB status=working, limit resting in Bybit book
  trigger_sequence:
    - process restart → runRecovery() → REST getOpenOrders: limit found
    - 'recovery: orphan order found, cancelling' logged
  expected_behavior:
    - orphan limit cancelled
    - intent errors (no monitoring state)
  observability_contract:
    - log: 'recovery: orphan order found, cancelling'
    - no 'position.opened' log
  code_refs:
    - src/execution/recovery/index.ts:271 (orphan cancel loop)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: rare

- id: strategy_4_2a.bybit.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while in monitoring (limit filled, SL and TP resting). Recovery
    rehydrates IntentState. manager.start() re-arms sl_tp_deadline monitor.
  preconditions:
    - intent in DB with status=monitoring, SL and TP resting
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
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: occasional

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_4_2a.bybit.SPEC_DIVERGENCE.BYBIT_MICROSECOND_TIMESTAMPS
  category: SPEC_DIVERGENCE
  severity: critical
  description: >
    Bybit WS events carry `updatedTime` in μs. Adapter ÷1000 mandatory. Limit fill,
    SL fill, TP fill all affected. Without conversion, db:fills timestamps corrupt.
  preconditions:
    - any Bybit WS fill event processed
  trigger_sequence:
    - Bybit WS: order {updatedTime: <μs>} → adapter / 1000 → ms
  expected_behavior:
    - db:fills createdAt in ms range for all bybit rows
  observability_contract:
    - db:fills createdAt > 1700000000000 AND < 2000000000000
  code_refs:
    - src/execution/adapters/privatews/bybit.ts (updatedTime / 1000)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_4_2a.bybit.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No Bybit limit order placed.
  preconditions:
    - kill switch mode != 'off', strategy_4_2a condition met for bybit
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
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: occasional
```
