# Checklist — binance / strategy_4_1a

Exchange: **binance**
Strategy: **strategy_4_1a** (Negative Funding Ladder LONG — Post-Funding Entry)
Spec: `docs-strategy/strategies/strategy_4_1.md`
Code: `src/execution/strategies/strategy_4_1a.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_4_1a.binance.ORDER_LIFECYCLE.ALL_RUNGS_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - entryOffsetSeconds (default 5s). Preflight passes.
    All N ladder rungs are placed in parallel via Promise.allSettled. Each rung
    gets a unique clientOrderId = ids.forIntent(intent.id, i). Binance receives N
    separate REST createOrder calls (limit, buy, reduceOnly=false). Each successful
    rung emits order.placed and logs ladder.rung_placed at info level.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent (default -0.6%)
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - market status = trading
    - N = ladderCount rungs configured
  trigger_sequence:
    - scheduler: evaluator fires at entryAt = nextFundingTimestamp - entryOffsetSeconds * 1000
    - manager.submit() called with strategy_4_1a TradeIntent
    - ladder_limit branch: Promise.allSettled places all N rungs
  expected_behavior:
    - intent.created logged (status=decided)
    - status transitions decided → submitted → acked → working
    - N × order.placed logged (kind=entry, orderType=limit, side=buy, reduceOnly=false)
    - N × ladder.rung_placed logged (info, rungIdx 0..N-1, limitPrice, rungQty)
    - N clientOrderIds registered in byEntryOrderId map
    - ladderRungs array initialized in IntentState with all rungs unfilled
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_4_1a", exchange: "binance"}
    - log: 'ladder.rung_placed' {rungIdx: 0..N-1, limitPrice: "<price below market>", rungQty: ">0"}  # N times
    - log: 'order.placed' {kind: "entry", side: "buy", orderType: "limit", reduceOnly: false}  # N times
    - db:orders N rows {kind: "entry", orderType: "limit", status: "pending"}
    - db:intentLifecycleEvents decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:2000 (intent.created log)
    - src/execution/execution/manager.ts:2395 (ladder_limit branch start)
    - src/execution/execution/manager.ts:2397 (ladderRungState construction)
    - src/execution/execution/manager.ts:2450 (Promise.allSettled — place all rungs)
    - src/execution/execution/manager.ts:2476 (order.placed emit per rung)
    - src/execution/execution/manager.ts:2489 (ladder.rung_placed info log)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (Entry — ladder_limit)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Binance limit orders use ORDER_TRADE_UPDATE on the user data stream for fill events.
    clientOrderId is passed as-is (no dash-stripping on Binance). All N rungs are
    pre-registered in byEntryOrderId before the REST calls begin, so concurrent WS
    fill events arriving during HTTP round-trips are not lost.

- id: strategy_4_1a.binance.ORDER_LIFECYCLE.RUNG_REJECTED_BY_EXCHANGE
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    One or more rungs are rejected by Binance (e.g. price too far from mark, min qty
    not met). The REST createOrder ACK returns status=rejected. Manager logs
    'ladder rung rejected' at warn level with rungIdx and reason. Remaining rungs
    proceed normally. The rejected rung's canonicalId is removed from byEntryOrderId.
  preconditions:
    - At least one rung's limitPrice or qty violates Binance exchange rules
  trigger_sequence:
    - rest.createOrder for rung i returns {status: "rejected", rejectReason: <reason>}
  expected_behavior:
    - 'ladder rung rejected' warn logged for the rejected rung
    - no order.placed emitted for the rejected rung
    - remaining rungs proceed to working state
    - T_funding timer still fires; if any other rungs filled → normal path
    - if all rungs rejected AND no fills → ladder_no_fills at T_funding
  observability_contract:
    - log: 'ladder rung rejected' {intentId, rungIdx: <i>, reason: "<reject reason>"}  # warn level
    - db:orders no row for the rejected rung (no order.placed emitted)
    - log: 'ladder.rung_placed' appears for non-rejected rungs only
  code_refs:
    - src/execution/execution/manager.ts:2472 (ack.status === 'rejected' check)
    - src/execution/execution/manager.ts:2473 (logger.warn 'ladder rung rejected')
    - src/execution/execution/manager.ts:2494 (byEntryOrderId.delete on catch)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (Entry — rung placement)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Binance may reject limit orders if the price deviates too far from the mark price
    (e.g. beyond the price filter bands). Rejection is synchronous in the REST ACK,
    distinct from a post-placement cancel. The warn log is the observable signal.

- id: strategy_4_1a.binance.ORDER_LIFECYCLE.PRE_FUNDING_FILL_WARNING
  category: ORDER_LIFECYCLE
  severity: medium
  description: >
    A limit rung fills before T_funding (e.g. market dips into the ladder early).
    WS ORDER_TRADE_UPDATE {X: "FILLED"} arrives before the T_funding timer fires.
    Manager marks rung.filled=true, updates s.filledQty and s.avgEntryPrice,
    transitions to partially_filled, and emits 'ladder.pre_funding_fill' warn.
    The position is kept; T_funding timer still resolves normally.
  preconditions:
    - intent in working status (rungs placed)
    - market price dips below a rung's limitPrice before T_funding
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {X: "FILLED", c: <rungClientOrderId>}
    - clock.now() < intent.nextFundingTimestamp when fill event processed
  expected_behavior:
    - handleEntryOrderEvent: rung.filled=true, aggregate qty/price updated
    - status transitions working → partially_filled
    - 'ladder.pre_funding_fill' logged (warn) with clientOrderId
    - metrics.intentRejectedTotal incremented with code=ladder_pre_funding_fill
    - T_funding timer still fires and processes any remaining unfilled rungs
  observability_contract:
    - log: 'ladder.pre_funding_fill' {intentId, clientOrderId: "<rung id>", fundingTs: <ts>}  # warn
    - db:intentLifecycleEvents transition to partially_filled
    - metrics: intentRejectedTotal{code="ladder_pre_funding_fill"} incremented
  code_refs:
    - src/execution/execution/manager.ts:1047 (ladder_limit branch in handleEntryOrderEvent)
    - src/execution/execution/manager.ts:1074 (transition partially_filled per rung fill)
    - src/execution/execution/manager.ts:1077 (clock.now() < nextFundingTimestamp check)
    - src/execution/execution/manager.ts:1078 (ladder.pre_funding_fill warn log)
    - src/execution/adapters/privatews/binance.ts:48 (ORDER_TRADE_UPDATE parser)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (Scenario A invariant)
  status: ⏳
  natural_occurrence: rare
  notes: >
    Binance ORDER_TRADE_UPDATE uses field 'c' for clientOrderId. The fill arrives
    in the same WS stream as SL/TP fills. The pre-funding fill is a deviation metric
    (funding accrual will differ from expected) but the position is not abandoned.

- id: strategy_4_1a.binance.ORDER_LIFECYCLE.T_FUNDING_TIMER_RESOLVES
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    T_funding timer fires (setTimeout set at delayToFunding = nextFundingTimestamp - clock.now()).
    Manager cancels all unfilled rungs via REST cancelOrder (best-effort). Computes
    aggregate filledQty and weighted-avg P_avg from s.ladderRungs. Emits order.filled
    programmatically with filledQty and avgFillPrice=P_avg. Transitions to filled.
    Calls handleEntryFilled → places SL (stop_market) + TP (limit) → transitions to monitoring.
  preconditions:
    - intent in working or partially_filled status
    - at least one rung has filled (s.filledQty > 0)
    - T_funding timer callback fires
  trigger_sequence:
    - setTimeout callback fires at delayToFunding ms after ladder placement
    - unfilled rungs: Promise.allSettled cancelOrder calls (best-effort)
    - s.filledQty > 0 check passes
    - bus.emit('order.filled', {filledQty: aggregate, avgFillPrice: P_avg})
    - transition(s, 'filled')
    - handleEntryFilled(s)
  expected_behavior:
    - unfilled rungs canceled on Binance (best effort — may silently fail if already filled)
    - order.filled emitted with aggregate filledQty and weighted avgFillPrice
    - position.opened logged (side=long, filledQty > 0)
    - SL placed (stop_market, sell, reduceOnly=true, qty=intent.volume)
    - TP placed (limit, sell, reduceOnly=true, qty=intent.volume)
    - order.placed logged for both SL and TP
    - status transitions: partially_filled → filled → monitoring
    - monitor armed with sl_tp_deadline policy
    - pollForSlTpFill started
  observability_contract:
    - log: 'order.filled' {filledQty: ">0", avgFillPrice: "<P_avg>"}
    - log: 'position.opened' {side: "long", filledQty: ">0"}
    - log: 'order.placed' {kind: "sl", side: "sell", orderType: "stop_market", reduceOnly: true}
    - log: 'order.placed' {kind: "tp", side: "sell", orderType: "limit", reduceOnly: true}
    - log: 'monitor.armed.sl_tp_deadline' {deadlineDelay, slId, tpId}  # debug level
    - db:intentLifecycleEvents →filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:2501 (delayToFunding setTimeout)
    - src/execution/execution/manager.ts:2507 (cancel unfilled rungs)
    - src/execution/execution/manager.ts:2517 (s.filledQty <= 0 → ladder_no_fills)
    - src/execution/execution/manager.ts:2529 (bus.emit order.filled)
    - src/execution/execution/manager.ts:2537 (transition filled)
    - src/execution/execution/manager.ts:2538 (handleEntryFilled call)
    - src/execution/execution/manager.ts:406 (sl_tp_deadline branch in handleEntryFilled)
    - src/execution/execution/manager.ts:577 (order.placed SL log)
    - src/execution/execution/manager.ts:580 (order.placed TP log)
    - src/execution/execution/manager.ts:782 (position.opened log)
    - src/execution/execution/monitor.ts:149 (monitor.armed.sl_tp_deadline debug log)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (T_funding resolution)
  status: ⏳
  natural_occurrence: routine
  notes: >
    This is the critical divergence from spec: handleEntryFilled runs at T_funding via
    timer, NOT when the last rung fills via WS. SL/TP sized to intent.volume; exchange
    clamps to actual position if position < volume.

- id: strategy_4_1a.binance.ORDER_LIFECYCLE.ZERO_FILLS_LADDER_NO_FILLS
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    T_funding timer fires but s.filledQty == 0 (no rungs filled). Manager calls
    setError with code='ladder_no_fills'. Intent transitions to error (terminal).
    No SL/TP are placed. Any resting rungs were already canceled in the timer callback.
  preconditions:
    - All rungs placed but none filled before T_funding
    - s.filledQty == 0 when timer callback runs
  trigger_sequence:
    - T_funding timer fires
    - unfilled rungs canceled (best-effort)
    - s.filledQty <= 0 branch taken
  expected_behavior:
    - intent.error logged with code=ladder_no_fills
    - status transitions working → error (terminal)
    - no position.opened, no SL/TP placed
    - no order.filled emitted
  observability_contract:
    - log: 'intent.error' {code: "ladder_no_fills"}
    - db:intentLifecycleEvents working→error (no filled or monitoring rows)
    - db:orders N entry rows in status=pending or cancelled (no sl/tp rows)
  code_refs:
    - src/execution/execution/manager.ts:2517 (s.filledQty <= 0 check)
    - src/execution/execution/manager.ts:2518 (setError 'ladder_no_fills')
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (zero-fill error path)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    This scenario occurs when the market never reaches the ladder price range before
    T_funding. The error is terminal — no retry or fallback entry. Verify by checking
    that no SL/TP are placed and no position is open on Binance.

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_4_1a.binance.TIMING.LADDER_PLACED_AT_CORRECT_OFFSET
  category: TIMING
  severity: high
  description: >
    All N rungs are placed starting at entryAt = nextFundingTimestamp - entryOffsetSeconds*1000
    (default T_f - 5000ms). The elapsed time from entryAt to the last order.placed log
    should be within a few hundred milliseconds (N REST calls in parallel + leverage set).
  preconditions:
    - scheduler running and synced to exchange clock
    - strategy condition met
  trigger_sequence:
    - scheduler: fires evaluate() at entryAt
    - manager.submit() runs ladder_limit path
  expected_behavior:
    - first ladder.rung_placed within ≤1500ms of entryAt
    - all N order.placed logs within ≤2000ms of entryAt (parallel REST calls)
  observability_contract:
    - log: 'ladder.rung_placed' {rungIdx: 0} timestamp ≤ entryAt + 1500ms
    - log: 'order.placed' {kind: "entry"} timestamps ≤ entryAt + 2000ms (all N)
  code_refs:
    - src/execution/strategies/strategy_4_1a.ts:84 (entryAt = nextFundingTimestamp - entryOffsetSeconds*1000)
    - src/execution/execution/manager.ts:2450 (Promise.allSettled parallel placement)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (Entry offset T_f - 5s)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Promise.allSettled means all N REST calls fire in parallel. On Binance, latency
    per createOrder REST call is typically 50-200ms. Leverage set runs before the
    ladder placement and is cached after the first call for a given symbol.

- id: strategy_4_1a.binance.TIMING.T_FUNDING_TIMER_FIRES_AT_CORRECT_TIME
  category: TIMING
  severity: critical
  description: >
    The T_funding timer (setTimeout) fires at approximately nextFundingTimestamp.
    delayToFunding = max(0, nextFundingTimestamp - clock.now()) computed after the
    ladder placement REST calls complete. The cancel+resolve logic runs within a few
    hundred ms of T_funding. SL/TP should be placed promptly after T_funding.
  preconditions:
    - intent in working or partially_filled status
    - T_funding timer armed
  trigger_sequence:
    - setTimeout callback fires (delayToFunding elapsed)
  expected_behavior:
    - timer callback starts within ≤500ms of nextFundingTimestamp
    - order.filled emitted within ≤1000ms of nextFundingTimestamp (after cancel loop)
    - order.placed for SL+TP within ≤2000ms of nextFundingTimestamp
  observability_contract:
    - log: 'order.filled' timestamp ≥ nextFundingTimestamp, ≤ nextFundingTimestamp + 2000ms
    - log: 'order.placed' {kind: "sl"} timestamp ≤ nextFundingTimestamp + 2500ms
  code_refs:
    - src/execution/execution/manager.ts:2501 (delayToFunding = max(0, nextFundingTimestamp - clock.now()))
    - src/execution/execution/manager.ts:2502 (setTimeout with delayToFunding)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (T_funding resolution)
  status: ⏳
  natural_occurrence: routine
  notes: >
    delayToFunding is computed after the REST calls for rung placement complete.
    If rung placement takes >5s total (very unlikely), delayToFunding could be
    negative and is clamped to 0, causing immediate resolution.

- id: strategy_4_1a.binance.TIMING.DEADLINE_FIRES_CANCEL_SL_TP
  category: TIMING
  severity: critical
  description: >
    Deadline timer fires at T_f + deadlineSeconds (default 60s). monitor.deadline_fired
    logged. settle('deadline') called. handleMonitorExit cancels both SL and TP (via
    cancelSiblingExit), then places a market close order (kind=close, side=sell,
    reduceOnly=true). Binance fills it immediately.
  preconditions:
    - intent in monitoring status
    - neither SL nor TP filled before T_f + deadlineSeconds
    - deadline timer armed in monitor
  trigger_sequence:
    - monitor deadline setTimeout fires at deadlineAt - skewMs
    - settle('deadline', {source: "timer"})
    - handleMonitorExit(s, 'deadline')
  expected_behavior:
    - 'monitor.deadline_fired' logged with deadlineAt timestamp
    - 'monitor.settle' logged {reason: "deadline", source: "timer"}
    - 'intent.exiting.start' logged {reason: "deadline"}
    - SL canceled, TP canceled on Binance
    - 'order.placed' logged {kind: "close", side: "sell", orderType: "market", reduceOnly: true}
    - close order fills, intent transitions to exited
  observability_contract:
    - log: 'monitor.deadline_fired' {intentId, deadlineAt: "<ts>"}
    - log: 'monitor.settle' {reason: "deadline"}
    - log: 'intent.exiting.start' {reason: "deadline"}
    - log: 'order.placed' {kind: "close", side: "sell", orderType: "market", reduceOnly: true}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:112 (deadlineDelay = max(0, deadlineAt - now - skewMs))
    - src/execution/execution/monitor.ts:114 (monitor.deadline_fired log)
    - src/execution/execution/monitor.ts:115 (settle 'deadline')
    - src/execution/execution/manager.ts:1479 (intent.exiting.start)
    - src/execution/execution/manager.ts:1576 (deadline/timed → cancel SL+TP then market close)
    - src/execution/execution/manager.ts:1585 (closeKind = 'close' for deadline)
    - src/execution/execution/manager.ts:1660 (order.placed close log)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (Deadline = T_f + deadlineSeconds)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    deadlineAt is set in strategy_4_1a.ts as nextFundingTimestamp + deadlineSeconds*1000.
    The close kind is 'close' (not 'timed') for deadline exits. Binance cancel errors
    during the SL/TP cancel step are swallowed by cancelSiblingExit — the market close
    proceeds regardless.

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_4_1a.binance.OCO.SL_FIRES_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    SL (stop_market) triggers and fills on Binance. WS ORDER_TRADE_UPDATE {X: "FILLED",
    c: <slClientOrderId>} arrives. Monitor detects via ws.order bus listener (slId match).
    settle('sl') called. handleMonitorExit cancels TP, sweeps reduce-only orders,
    transitions to exited.
  preconditions:
    - intent in monitoring status with SL and TP placed
    - price drops to SL trigger price
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {X: "FILLED", c: <slId>}
    - monitor ws.order listener: order.clientOrderId === slId → settle('sl')
    - handleMonitorExit(s, 'sl')
  expected_behavior:
    - monitor.settle {reason: "sl", source: "ws"}
    - intent.exiting.start {reason: "sl"}
    - TP canceled on Binance
    - sweepReduceOnlyOrders called
    - intent.exited.complete logged {exitReason: "sl"}
    - status monitoring → exiting → exited
  observability_contract:
    - log: 'monitor.settle' {reason: "sl", source: "ws"}
    - log: 'intent.exiting.start' {reason: "sl"}
    - log: 'intent.exited.complete' {exitReason: "sl"}
    - db:intentLifecycleEvents monitoring→exiting→exited
    - db:orders sl row {status: "filled"}, tp row {status: "cancelled"}
  code_refs:
    - src/execution/execution/monitor.ts:123 (ws.order bus listener)
    - src/execution/execution/monitor.ts:127 (order.clientOrderId === slId → settle sl)
    - src/execution/execution/manager.ts:1502 (reason === 'sl' branch)
    - src/execution/execution/manager.ts:1561 (sweepReduceOnlyOrders)
    - src/execution/execution/manager.ts:1565 (transition exited)
    - src/execution/execution/manager.ts:1565 (intent.exited.complete log)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (SL exit)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    On Binance, stop_market orders emit ORDER_TRADE_UPDATE with status=FILLED when
    triggered. The clientOrderId in field 'c' must match the slId exactly. avgFillPrice
    in the WS event is used to set s.avgExitPrice.

- id: strategy_4_1a.binance.OCO.TP_FILLS_SL_CANCELED
  category: OCO
  severity: critical
  description: >
    TP (limit) fills on Binance. WS ORDER_TRADE_UPDATE {X: "FILLED", c: <tpClientOrderId>}
    arrives. Monitor detects via ws.order bus listener (tpId match). settle('tp') called.
    handleMonitorExit cancels SL, sweeps reduce-only orders, transitions to exited.
  preconditions:
    - intent in monitoring status with SL and TP placed
    - price rises to TP limit price
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {X: "FILLED", c: <tpId>}
    - monitor ws.order listener: order.clientOrderId === tpId → settle('tp')
    - handleMonitorExit(s, 'tp')
  expected_behavior:
    - monitor.settle {reason: "tp", source: "ws"}
    - intent.exiting.start {reason: "tp"}
    - SL canceled on Binance
    - sweepReduceOnlyOrders called
    - intent.exited.complete logged {exitReason: "tp"}
    - status monitoring → exiting → exited
  observability_contract:
    - log: 'monitor.settle' {reason: "tp", source: "ws"}
    - log: 'intent.exiting.start' {reason: "tp"}
    - log: 'intent.exited.complete' {exitReason: "tp"}
    - db:intentLifecycleEvents monitoring→exiting→exited
    - db:orders tp row {status: "filled"}, sl row {status: "cancelled"}
  code_refs:
    - src/execution/execution/monitor.ts:136 (order.clientOrderId === tpId → settle tp)
    - src/execution/execution/manager.ts:1502 (reason === 'tp' branch mirrors sl)
    - src/execution/execution/manager.ts:1565 (intent.exited.complete)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (TP exit)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    TP is a limit sell order — Binance fills it as a regular limit order fill event
    on ORDER_TRADE_UPDATE. The monitor matches by clientOrderId field 'c'.

- id: strategy_4_1a.binance.OCO.SL_TP_POLL_FALLBACK
  category: OCO
  severity: high
  description: >
    WS fill event for SL or TP does not arrive (e.g. WS gap during monitoring).
    pollForSlTpFill (15s × 50 = ~12min polling loop) detects a filled SL or TP via
    REST getOrder. Calls monitor.disarm and handleMonitorExit with the detected reason.
  preconditions:
    - intent in monitoring status
    - SL or TP fills on exchange but WS event not received by manager
  trigger_sequence:
    - pollForSlTpFill loop: rest.getOrder for slRef returns status=filled
  expected_behavior:
    - pollForSlTpFill detects slRef.status=filled → handleMonitorExit(s, 'sl')
    - or tpRef.status=filled → handleMonitorExit(s, 'tp')
    - normal sl/tp exit sequence follows
  observability_contract:
    - log: 'intent.exiting.start' {reason: "sl"} or {reason: "tp"} (from poll path)
    - log: 'intent.exited.complete' {exitReason: "sl" or "tp"}
    - no prior monitor.settle {source: "ws"} (distinguishes poll from WS path)
  code_refs:
    - src/execution/execution/manager.ts:1299 (pollForSlTpFill)
    - src/execution/execution/manager.ts:1306 (POLL_INTERVAL_MS = 15000)
    - src/execution/execution/manager.ts:1307 (MAX_POLLS = 50)
    - src/execution/execution/manager.ts:1322 (slOrder.status === 'filled' → handleMonitorExit sl)
    - src/execution/execution/manager.ts:1340 (tpOrder.status === 'filled' → handleMonitorExit tp)
    - src/execution/execution/manager.ts:786 (pollForSlTpFill started after SL/TP placed)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (no poll fallback in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    The poll fallback is the safety net when WS ORDER_TRADE_UPDATE for SL/TP is missed.
    On Binance the WS is reliable but the poll provides defense in depth. The poll runs
    concurrently with the WS monitor from the moment SL+TP are placed.

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_4_1a.binance.WEBSOCKET.RUNG_FILL_DETECTED_VIA_WS
  category: WEBSOCKET
  severity: critical
  description: >
    A ladder rung fills on Binance. ORDER_TRADE_UPDATE {X: "FILLED", c: <rungClientOrderId>}
    arrives on the private WS. The WS handler routes via byEntryOrderId lookup using
    canonicalize(exchange, clientOrderId). handleEntryOrderEvent is called; the ladder
    branch updates rung state, recomputes aggregate, transitions to partially_filled.
  preconditions:
    - intent in working status
    - one or more rungs at resting limit prices
    - Binance private WS connected
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {X: "FILLED", c: <rungClientOrderId>}
    - mapOrderTradeUpdate parses event; clientOrderId from field 'c'
    - byEntryOrderId lookup → handleEntryOrderEvent
  expected_behavior:
    - rung.filled=true, rung.filledQty and avgFillPrice updated
    - s.filledQty and s.avgEntryPrice recomputed from all rungs
    - transition to partially_filled (even if only one rung filled)
    - if clock.now() < nextFundingTimestamp: ladder.pre_funding_fill warn emitted
  observability_contract:
    - db:intentLifecycleEvents transition to partially_filled on each rung fill
    - log: 'ladder.pre_funding_fill' (warn) if fill is before T_funding
    - NO order.filled emitted per rung (order.filled only at T_funding timer)
  code_refs:
    - src/execution/adapters/privatews/binance.ts:48 (ORDER_TRADE_UPDATE parser)
    - src/execution/execution/manager.ts:1047 (ladder_limit branch)
    - src/execution/execution/manager.ts:1053 (order.status === 'filled' → rung.filled=true)
    - src/execution/execution/manager.ts:1071 (recompute aggregate)
    - src/execution/execution/manager.ts:1074 (transition partially_filled)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (WS rung fill tracking)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Binance clientOrderId is in WS field 'c'. canonicalize for Binance is identity
    (no dash-stripping). All N rung clientOrderIds are pre-registered so any fill
    arriving during parallel REST placement is handled correctly.

- id: strategy_4_1a.binance.WEBSOCKET.RECONNECT_RUNGS_STILL_RESTING
  category: WEBSOCKET
  severity: high
  description: >
    Binance private WS disconnects and reconnects while rungs are resting (status=working
    or partially_filled). store.reconcile() is called on reconnect, fetching open orders
    and positions via REST. Resting limit rungs remain open on Binance. No duplicate
    order.placed events are emitted. T_funding timer continues unaffected.
  preconditions:
    - intent in working or partially_filled status
    - one or more rung limit orders resting on Binance
    - WS disconnects then reconnects
  trigger_sequence:
    - ws.connection event: {state: "disconnected"}
    - ws.connection event: {state: "connected"}
    - store.reconcile() called
  expected_behavior:
    - store.reconcile fetches open orders from REST — rungs still visible
    - byEntryOrderId map remains intact (set before REST calls, not cleared on reconnect)
    - T_funding timer not reset (continues to fire at original nextFundingTimestamp)
    - no duplicate ladder.rung_placed or order.placed logs
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} triggers reconcile (internal — no logger.info)
    - log: event='ws.connection' {exchange: "binance", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - state maps updated; resting rungs remain in byEntryOrderId
    - T_funding timer fires normally at nextFundingTimestamp
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile on reconnect)
    - src/execution/execution/manager.ts:2400 (byEntryOrderId populated before REST calls)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (no WS reconnect behavior in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    The byEntryOrderId map is populated in the main submit() path BEFORE REST calls,
    so it persists through WS reconnects. Any fills that arrived during the gap will
    be detected by the T_funding timer's aggregate check on s.filledQty.

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_4_1a.binance.RECOVERY.RESTART_WITH_RUNGS_OPEN
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while intent is in status=working (rungs placed, T_funding pending).
    Recovery rehydrates IntentState from DB. byEntryOrderId map is rebuilt for all rung
    clientOrderIds from ladderRungs in the rehydrated state. T_funding timer is NOT
    re-armed by recovery (recovery only re-arms monitoring intents). The rungs remain
    open on Binance until T_funding fires on the new process — but T_funding is
    recalculated from the rehydrated intent.nextFundingTimestamp.
  preconditions:
    - intent in DB with status=working
    - ladderRungs array persisted with rung clientOrderIds
    - process restarts before T_funding
  trigger_sequence:
    - process restart
    - runRecovery() called
    - IntentState rehydrated with status=working and ladderRungs
    - byEntryOrderId rebuilt for all rung canonicalIds
  expected_behavior:
    - 'recovery: rehydrated intent states' logged with rehydratedCount ≥ 1
    - byEntryOrderId map populated for all N rung clientOrderIds
    - new T_funding timer armed for remaining time (nextFundingTimestamp - now)
    - if T_funding is past: timer fires immediately with delayToFunding=0
    - normal T_funding resolution follows
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: "≥1"}
    - no duplicate order.placed logs (rungs already placed — not re-placed)
    - order.filled emitted at T_funding with recomputed aggregate
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated intent states log)
    - src/execution/execution/manager.ts:2400 (byEntryOrderId rebuilt from ladderRungs)
    - src/execution/execution/manager.ts:2501 (T_funding timer with delayToFunding)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (no recovery in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Critical: if a rung filled during the downtime and the WS fill event was missed,
    the T_funding timer will still aggregate from s.filledQty at the time of recovery.
    If filledQty=0 at recovery time but a fill occurred, ladder_no_fills will be
    emitted erroneously. A REST getPositions call in recovery could mitigate this gap.

- id: strategy_4_1a.binance.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while intent is in status=monitoring (SL+TP placed, deadline pending).
    Recovery rehydrates IntentState, rebuilds exitOrderRefs (sl and tp refs). manager.start()
    re-arms the sl_tp_deadline monitor for all monitoring intents. pollForSlTpFill is
    restarted. Deadline timer re-armed with remaining delay.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=sl_tp_deadline, deadlineAt in the future
    - sl and tp order rows exist in DB
  trigger_sequence:
    - process restart
    - runRecovery()
    - manager.start() re-arms monitoring intents
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor.armed.sl_tp_deadline logged (debug) with updated deadlineDelay
    - pollForSlTpFill restarted for the monitoring intent
    - deadline fires at deadlineAt - skewMs (adjusted for elapsed time)
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: "≥1"}
    - log: 'monitor.armed.sl_tp_deadline' {deadlineDelay: "remaining ms", slId, tpId}  # debug
    - exits normally via SL/TP fill or deadline after recovery
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated intent states log)
    - src/execution/execution/manager.ts:1888 (start — re-arm monitoring intents)
    - src/execution/execution/monitor.ts:108 (sl_tp_deadline arm)
    - src/execution/execution/monitor.ts:149 (monitor.armed.sl_tp_deadline debug)
    - src/execution/execution/manager.ts:786 (pollForSlTpFill restart)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (no recovery in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    If deadlineAt is in the past when recovery runs, deadlineDelay=0 and the deadline
    fires immediately. The position may still be open — the market close order is placed.

# ── STRATEGY_SPECIFIC ────────────────────────────────────────────────────────

- id: strategy_4_1a.binance.STRATEGY_SPECIFIC.WEIGHTED_AVG_P_AVG_COMPUTED
  category: STRATEGY_SPECIFIC
  severity: critical
  description: >
    At T_funding timer, P_avg is computed as the weighted average fill price across
    all filled rungs: sum(rung.filledQty * rung.avgFillPrice) / sum(rung.filledQty).
    SL price = P_avg * (1 - slPct/100), TP price = P_avg * (1 + tpPct/100).
    slPct = |fundingRatePercent| * slMultiplier. tpPct = config.takeProfitPct.
  preconditions:
    - Multiple rungs filled with different fill prices
    - T_funding timer fired
  trigger_sequence:
    - T_funding timer: aggregate s.filledQty and s.avgEntryPrice from ladderRungs
    - handleEntryFilled: price = s.avgEntryPrice for SL/TP calculation
  expected_behavior:
    - s.avgEntryPrice = totalQtyPrice / totalQty (weighted average)
    - SL placed at P_avg * (1 - slPct/100)
    - TP placed at P_avg * (1 + tpPct/100)
    - order.placed for SL has stopPrice matching formula
    - order.placed for TP has price matching formula
  observability_contract:
    - log: 'order.placed' {kind: "sl", stopPrice: "<P_avg*(1-slPct/100)>"}
    - log: 'order.placed' {kind: "tp", price: "<P_avg*(1+tpPct/100)>"}
    - db:orders sl and tp rows with correct prices derivable from fill price
  code_refs:
    - src/execution/execution/manager.ts:1063 (totalQtyPrice += rung.filledQty * rung.avgFillPrice)
    - src/execution/execution/manager.ts:1072 (s.avgEntryPrice = totalQtyPrice / totalQty)
    - src/execution/execution/manager.ts:411 (price = s.avgEntryPrice in handleEntryFilled)
    - src/execution/execution/manager.ts:458 (slPrice = price * (1 - slPct/100))
    - src/execution/execution/manager.ts:459 (tpPrice = price * (1 + tpPct/100))
    - src/execution/strategies/strategy_4_1a.ts:49 (slPct = absF * slMultiplier)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (P_avg weighted average)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Single rung filled: P_avg = that rung's avgFillPrice exactly. Multiple rungs:
    weighted by filledQty. The computation happens in handleEntryOrderEvent per rung
    fill (incremental update), then re-used by handleEntryFilled at T_funding.

- id: strategy_4_1a.binance.STRATEGY_SPECIFIC.SL_TP_SIZED_TO_INTENT_VOLUME
  category: STRATEGY_SPECIFIC
  severity: high
  description: >
    SL and TP are sized to intent.volume (full intended qty), not just s.filledQty.
    This hedges any late incremental fills. Binance clamps reduceOnly orders to the
    actual open position size if volume > actual position.
  preconditions:
    - T_funding timer fires with s.filledQty < intent.volume (partial fill)
    - handleEntryFilled runs with exitQty = intent.volume
  trigger_sequence:
    - handleEntryFilled: exitQty = intent.volume (line 429)
    - REST createOrder for SL and TP with qty = exitQty = intent.volume
  expected_behavior:
    - SL qty = intent.volume in order.placed log
    - TP qty = intent.volume in order.placed log
    - if actual position < intent.volume, Binance silently clamps qty to position size
  observability_contract:
    - log: 'order.placed' {kind: "sl", qty: "<intent.volume>"}
    - log: 'order.placed' {kind: "tp", qty: "<intent.volume>"}
    - actual filled qty on exchange may differ (Binance clamps reduceOnly)
  code_refs:
    - src/execution/execution/manager.ts:429 (exitQty = intent.volume)
    - src/execution/execution/manager.ts:431 (getPositions to check actual size)
    - src/execution/execution/manager.ts:445 (exitQty = pos.qty if oversized)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (SL/TP sizing)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    getPositions REST call happens in handleEntryFilled to detect oversized positions.
    If position > intent.volume (shouldn't happen normally), exitQty is adjusted up.

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_4_1a.binance.SPEC_DIVERGENCE.FILLED_AT_T_FUNDING_NOT_LAST_RUNG
  category: SPEC_DIVERGENCE
  severity: critical
  description: >
    The 'filled' state transition and handleEntryFilled call happen at T_funding via
    timer, NOT when the last ladder rung fills via WS. This means the transition from
    partially_filled → filled occurs at T_funding even if all rungs filled minutes
    earlier. P_avg is the aggregate from s.ladderRungs at T_funding time — same values
    as computed incrementally during WS fills.
  preconditions:
    - All rungs fill via WS before T_funding
  trigger_sequence:
    - All rung WS fills arrive (state=partially_filled after each)
    - T_funding timer fires → transition filled → handleEntryFilled
  expected_behavior:
    - status stays at partially_filled (not filled) even after last rung fills via WS
    - status transitions to filled ONLY when T_funding timer fires
    - handleEntryFilled runs once, at T_funding, regardless of rung fill timing
  observability_contract:
    - db:intentLifecycleEvents: no 'filled' row until T_funding fires
    - log: 'order.filled' emitted only at T_funding timer (not per-rung WS fill)
    - all rung fills are in partially_filled state transitions
  code_refs:
    - src/execution/execution/manager.ts:2502 (T_funding timer: transition filled + handleEntryFilled)
    - src/execution/execution/manager.ts:1074 (per-rung WS fill → only partially_filled transition)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (undocumented — spec implies fill-driven)
  status: ⏳
  natural_occurrence: routine
  notes: >
    This is the most important spec divergence. A verifier looking for 'filled' state
    immediately after all rungs fill via WS would be confused. The correct signal is
    order.filled at T_funding time (not per-rung). Monitor and SL/TP are armed only
    after T_funding, not before.

- id: strategy_4_1a.binance.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch is active (mode != 'off') when a strategy_4_1a intent would otherwise
    be submitted. Preflight rejects the intent with code=kill_switch before any REST
    call to the exchange. The spec has no mention of a kill switch.
  preconditions:
    - kill switch mode != 'off'
    - strategy_4_1a condition met (funding threshold, balance, etc.)
  trigger_sequence:
    - manager.submit() → preflight → killSwitch.canPlaceOrder() returns false
  expected_behavior:
    - intent.created logged (decided status)
    - intent.error logged with code=kill_switch
    - no ladder.rung_placed, no order.placed
  observability_contract:
    - log: 'intent.error' {code: "kill_switch"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:intentLifecycleEvents decided→error
    - db:orders no rows for this intentId
  code_refs:
    - src/execution/execution/preflight.ts:32 (kill switch check)
    - src/execution/risk/kill-switch.ts (KillSwitch implementation)
  spec_refs:
    - docs-strategy/strategies/strategy_4_1.md (no kill switch mentioned)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Emergency stop for all strategies. Kill switch check runs in preflight before
    setLeverage or any order placement. Intent is still created in DB (decided state)
    then immediately errors.
```
