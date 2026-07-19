# Checklist — kucoin / strategy_4_2a

Exchange: **kucoin**
Strategy: **strategy_4_2a** (Negative Funding Single Limit LONG — Post-Funding Entry)
Spec: `docs-strategy/strategies/strategy_4_2.md`
Code: `src/execution/strategies/strategy_4_2a.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`

---

**KuCoin-specific notes:**

- REST limit entry (no WS adapter)
- KuCoin LIMIT order WS fills DO echo `clientOrderId` → WS routing works for limit fill
- `cancelIgnoreCode: 100004` (order not found = success) for all cancels
- ms timestamps throughout
- No clientOrderId transformation

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_4_2a.kucoin.ORDER_LIFECYCLE.LIMIT_ENTRY_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - 5s. Preflight passes. A limit BUY order is placed via
    REST createOrder at price P_current × (1 - priceOffsetPct/100). No clientOrderId
    transformation for KuCoin. Expiry timer armed at deadlineAt. pollForEntryFill started.
    KuCoin limit fills echo clientOrderId → WS routing works.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - refPrice available
  trigger_sequence:
    - scheduler fires at entryAt → manager.submit() → limit entry branch → REST createOrder
  expected_behavior:
    - intent.created logged (strategy=strategy_4_2a, exchange=kucoin)
    - order.placed (limit) logged with limitPrice
    - status decided → submitted → acked → working
    - expiry timer set at deadlineAt
    - pollForEntryFill started (15×1s backup)
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_4_2a", exchange: "kucoin"}
    - log: 'order.placed (limit)' {intentId, limitPrice, qty}
    - db:orders {kind: "entry", orderType: "limit", status: "pending"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:2546 (limit entry path)
    - src/execution/execution/manager.ts:2578 (createOrder call)
    - src/execution/execution/manager.ts:2619 (order.placed (limit) log)
    - src/execution/execution/manager.ts:2625 (expiry timer)
    - src/execution/execution/manager.ts:2649 (pollForEntryFill start)
    - src/execution/strategies/strategy_4_2a.ts:64 (expireAt=deadlineAt)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (Limit entry at T_f - 5s)
  status: ⏳
  natural_occurrence: routine
  notes: >
    KuCoin limit fills echo clientOrderId → WS routing primary; pollForEntryFill is backup.

- id: strategy_4_2a.kucoin.ORDER_LIFECYCLE.LIMIT_FILLS_AFTER_FUNDING
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    After T_f, price drops to limit level. KuCoin WS 'orders' emits fill for limit
    order with clientOrderId. Manager routes via byEntryOrderId, logs order.filled,
    transitions to filled. handleEntryFilled places SL + TP and arms sl_tp_deadline
    monitor. pollForSlTpFill started.
  preconditions:
    - limit order in status=working, KuCoin WS connected, price drops post-funding
  trigger_sequence:
    - KuCoin WS: orders {status: "filled", clientOrderId: <id>}
    - byEntryOrderId lookup → handleEntryFilled
  expected_behavior:
    - order.filled logged (avgFillPrice = limit price, ms timestamps)
    - position.opened logged (side=long)
    - SL (stop_market, sell) + TP (limit, sell) placed via REST
    - monitor.armed.sl_tp_deadline logged (debug)
  observability_contract:
    - log: 'order.filled' {exchange: "kucoin", avgFillPrice: "<limitPrice>"}
    - log: 'position.opened' {side: "long"}
    - log: 'order.placed' {kind: "sl"} and {kind: "tp"}
    - log: 'monitor.armed.sl_tp_deadline' (debug)
    - db:intentLifecycleEvents working→filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:1140 (handleEntryOrderEvent fill branch)
    - src/execution/execution/manager.ts:406 (handleEntryFilled sl_tp_deadline)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: routine

- id: strategy_4_2a.kucoin.ORDER_LIFECYCLE.LIMIT_EXPIRES_UNFILLED
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Expiry timer fires at deadlineAt without the limit order having filled. cancelOrder
    (100004 OK) called on KuCoin. setError('limit_order_expired'). Intent errors.
  preconditions:
    - limit in working, unfilled, clock.now() >= deadlineAt
  trigger_sequence:
    - expiry setTimeout fires → cancelOrder (100004 OK) → setError('limit_order_expired')
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
    - docs-strategy/strategies/strategy_4_2.md (Expiry)
  status: ⏳
  natural_occurrence: occasional

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_4_2a.kucoin.TIMING.DEADLINE_FIRES_IF_FILLED
  category: TIMING
  severity: critical
  description: >
    If limit filled and monitoring active, deadline fires at deadlineAt. SL and TP
    cancelled (100004 OK each), market close placed.
  preconditions:
    - intent in monitoring, neither SL nor TP filled before deadlineAt
  trigger_sequence:
    - monitor.settle('deadline') → handleMonitorExit → cancel [sl, tp] → market close
  expected_behavior:
    - oco.cancel.start for SL and TP (100004 = success each)
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

- id: strategy_4_2a.kucoin.OCO.SL_FILLS_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    SL stop_market (sell) fills (long). KuCoin WS 'orders' fill for SL with
    clientOrderId. monitor.settle('sl'). handleMonitorExit cancels TP (100004 OK).
  preconditions:
    - intent in monitoring, SL and TP resting, price drops below SL stop
  trigger_sequence:
    - KuCoin WS: orders {status: "filled", clientOrderId: <slId>}
    - monitor.settle('sl') → cancel TP (100004 OK)
  expected_behavior:
    - monitor.settle {reason: "sl"}
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
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: occasional

- id: strategy_4_2a.kucoin.OCO.TP_FILLS_SL_CANCELED
  category: OCO
  severity: critical
  description: >
    TP limit (sell) fills for the long. KuCoin WS 'orders' fill for TP with
    clientOrderId. monitor.settle('tp'). handleMonitorExit cancels SL (100004 OK).
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
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: occasional

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_4_2a.kucoin.RECOVERY.RESTART_WHILE_LIMIT_RESTING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while limit order is resting in KuCoin book (status=working).
    Recovery sees resting limit as orphan and cancels it (100004 OK). Intent stays
    in error. No SL/TP placed.
  preconditions:
    - intent in DB status=working, limit order resting in KuCoin book
  trigger_sequence:
    - process restart → runRecovery() → REST getOpenOrders: limit found
    - 'recovery: orphan order found, cancelling' logged
  expected_behavior:
    - orphan limit cancelled (100004 OK)
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

- id: strategy_4_2a.kucoin.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while in monitoring (limit filled, SL and TP resting). Recovery
    rehydrates IntentState. manager.start() re-arms sl_tp_deadline monitor.
    cancelIgnoreCode=100004 applied.
  preconditions:
    - intent in DB with status=monitoring
    - exitOrderRefs.sl and .tp present
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

- id: strategy_4_2a.kucoin.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch active. Preflight rejects. No KuCoin limit order placed.
  preconditions:
    - kill switch mode != 'off', strategy_4_2a condition met for kucoin
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

- id: strategy_4_2a.kucoin.SPEC_DIVERGENCE.KUCOIN_LIMIT_FILLS_ECHO_CLIENT_ORDER_ID
  category: SPEC_DIVERGENCE
  severity: low
  description: >
    KuCoin LIMIT order fills DO echo clientOrderId (only MARKET fills lack it).
    strategy_4_2a uses a single limit entry → WS routing works normally for limit fill.
    pollForEntryFill is a backup path, not primary, unlike market-entry strategies.
  preconditions:
    - limit entry fill event arrives on KuCoin WS 'orders' channel
  trigger_sequence:
    - KuCoin WS: orders {status: "filled", clientOrderId: <id>} (limit fill)
    - byEntryOrderId lookup succeeds → normal WS routing
  expected_behavior:
    - fill detected via WS routing (<1s latency, no REST poll latency)
  observability_contract:
    - log: 'order.filled' from WS routing (not REST poll)
  code_refs:
    - src/execution/adapters/privatews/kucoin.ts (limit fill: clientOrderId present)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md
  status: ⏳
  natural_occurrence: routine
  notes: >
    Contrast with strategy_2/strategy_3a/strategy_1_ws where market fills lack clientOrderId.
    Limit order strategies on KuCoin work with normal WS routing.
```
