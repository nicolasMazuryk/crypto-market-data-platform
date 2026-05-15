# Checklist — binance / strategy_4_2a

Exchange: **binance**
Strategy: **strategy_4_2a** (Negative Funding Single Limit LONG — Post-Funding Entry)
Spec: `docs-strategy/strategies/strategy_4_2.md`
Code: `src/execution/strategies/strategy_4_2a.ts`, `src/execution/execution/manager.ts`, `src/execution/execution/monitor.ts`

---

```yaml
# ── ORDER_LIFECYCLE ─────────────────────────────────────────────────────────

- id: strategy_4_2a.binance.ORDER_LIFECYCLE.LIMIT_ENTRY_PLACED
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    Scheduler fires at T_f - entryOffsetSeconds (default 5s). Preflight passes.
    setLeverage succeeds. A limit BUY order is placed via REST createOrder at price
    P_current × (1 - priceOffsetPct/100), where priceOffsetPct = absF * limitOffsetMult.
    The limit sits in the order book BELOW current price, intended to fill after T_funding
    during the post-funding price drop. expireAt = deadlineAt = T_f + deadlineSeconds.
  preconditions:
    - fundingRatePercent < -negativeFundingThresholdPercent (default -0.6%)
    - available USDT >= amountUsd / leverage
    - kill switch inactive
    - market status = trading
    - refPrice available
  trigger_sequence:
    - scheduler: evaluator fires at entryAt = nextFundingTimestamp - entryOffsetSeconds * 1000
    - manager.submit() called with strategy_4_2a TradeIntent
  expected_behavior:
    - intent.created logged (status=decided, strategy=strategy_4_2a)
    - intent.submitted logged (entryKind=limit)
    - order.placed (limit) logged with limitPrice and qty
    - status transitions decided → submitted → acked → working
    - expiry timer armed at delayToExpiry = deadlineAt - now
    - pollForEntryFill REST poll started (15×1s)
    - entry clientOrderId registered in byEntryOrderId map
  observability_contract:
    - log: 'intent.created' {strategy: "strategy_4_2a", exchange: "binance"}
    - log: 'intent.submitted' {entryKind: "limit"}
    - log: 'order.placed (limit)' {intentId, limitPrice, qty}
    - bus: 'order.placed' {kind: "entry", side: "buy", orderType: "limit", reduceOnly: false}
    - db:orders row {kind: "entry", orderType: "limit", reduceOnly: false, status: "pending"}
    - db:intentLifecycleEvents transitions decided→submitted→acked→working
  code_refs:
    - src/execution/execution/manager.ts:2000 (intent.created log)
    - src/execution/execution/manager.ts:2095 (intent.submitted)
    - src/execution/execution/manager.ts:2546 (limit entry path begins)
    - src/execution/execution/manager.ts:2552 (limitPrice calculation)
    - src/execution/execution/manager.ts:2578 (createOrder call)
    - src/execution/execution/manager.ts:2619 (order.placed (limit) log)
    - src/execution/execution/manager.ts:2625 (expiry timer setup)
    - src/execution/execution/manager.ts:2649 (pollForEntryFill start)
    - src/execution/strategies/strategy_4_2a.ts:64 (entryPolicy limit, expireAt=deadlineAt)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (Entry Policy — limit order at T_f - 5s)
  status: ⏳
  natural_occurrence: routine
  notes: >
    The limit price is BELOW current price. On Binance, the clientOrderId has no transformation.
    Unlike strategy_1 (market), this order rests in the book and may not fill. The expiry timer
    fires at deadlineAt (= T_f + deadlineSeconds), not immediately after T_f.

- id: strategy_4_2a.binance.ORDER_LIFECYCLE.LIMIT_FILLS_AFTER_FUNDING
  category: ORDER_LIFECYCLE
  severity: critical
  description: >
    After T_funding, price drops to the limit level and the resting limit BUY fills.
    Binance emits ORDER_TRADE_UPDATE with X=FILLED on the private WS. Manager routes
    via byEntryOrderId lookup (field 'c'=clientOrderId), logs order.filled, transitions
    to filled, then calls handleEntryFilled which places SL+TP and arms the deadline monitor.
    SL anchored to avgFillPrice (the actual limit fill price).
  preconditions:
    - entry limit order in status=working
    - Binance private WS connected
    - price drops to limit level after T_f
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {X: "FILLED", c: <clientOrderId>, L: <avgFillPrice>}
  expected_behavior:
    - order.filled logged (filledQty, avgFillPrice from limit fill)
    - status transitions working → filled → monitoring
    - position.opened logged (side=long, filledQty > 0)
    - order.placed logged for SL (kind=sl, orderType=stop_market, stopPrice=avgFillPrice*(1-slPct/100))
    - order.placed logged for TP (kind=tp, orderType=limit, price=avgFillPrice*(1+tpPct/100))
    - monitor.armed.sl_tp_deadline logged (debug)
    - pollForSlTpFill started (15s×50)
  observability_contract:
    - log: 'order.filled' {exchange: "binance", filledQty: ">0", avgFillPrice: "<limitPrice>"}
    - log: 'position.opened' {side: "long", filledQty: ">0"}
    - log: 'order.placed' {kind: "sl", side: "sell", orderType: "stop_market"}
    - log: 'order.placed' {kind: "tp", side: "sell", orderType: "limit"}
    - log: 'monitor.armed.sl_tp_deadline' (debug)
    - db:orders rows for sl and tp (reduceOnly: true)
    - db:intentLifecycleEvents working→filled→monitoring
  code_refs:
    - src/execution/adapters/privatews/binance.ts:48 (ORDER_TRADE_UPDATE parser)
    - src/execution/execution/manager.ts:1140 (handleEntryOrderEvent fill branch)
    - src/execution/execution/manager.ts:1155 (order.filled log)
    - src/execution/execution/manager.ts:1157 (transition filled)
    - src/execution/execution/manager.ts:406 (handleEntryFilled sl_tp_deadline branch)
    - src/execution/execution/manager.ts:458 (slPrice/tpPrice from avgFillPrice)
    - src/execution/execution/manager.ts:579 (order.placed sl log)
    - src/execution/execution/manager.ts:580 (order.placed tp log)
    - src/execution/execution/manager.ts:782 (position.opened log)
    - src/execution/execution/manager.ts:784 (transition monitoring, monitor.arm)
    - src/execution/execution/monitor.ts:149 (monitor.armed.sl_tp_deadline debug)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (Entry fills post T_funding — SL/TP anchored to fill price)
  status: ⏳
  natural_occurrence: routine
  notes: >
    KEY DIFFERENCE from strategy_1: the fill price is the limit price (below pre-trade price),
    NOT the market price at T_f. SL and TP are anchored to this actual fill price.
    avgFillPrice is present on Binance FILLED events.

- id: strategy_4_2a.binance.ORDER_LIFECYCLE.LIMIT_PARTIAL_AT_EXPIRY
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    The expiry timer fires at deadlineAt. The limit order has partially filled (s.filledQty > 0)
    but has not fully filled. Manager cancels the remaining open quantity, then calls
    handleEntryFilled with the partial qty. SL+TP are placed from the partial avgFillPrice.
  preconditions:
    - entry limit order partially filled before deadlineAt
    - expiry timer fires (TERMINAL check fails, status != filled/monitoring)
  trigger_sequence:
    - setTimeout callback at delayToExpiry fires
    - s.filledQty > 0 check passes
    - rest.cancelOrder called for the resting limit
    - transition(s, 'filled') then handleEntryFilled(s)
  expected_behavior:
    - log: 'limit entry expired — cancelling unfilled limit'
    - cancelOrder called on Binance (best-effort; any error swallowed)
    - order.filled logged for partial qty
    - position.opened logged
    - SL+TP placed from partial fill avgFillPrice
    - monitor.armed.sl_tp_deadline
  observability_contract:
    - log: 'limit entry expired — cancelling unfilled limit' {intentId}
    - log: 'order.filled' {filledQty: "<partial qty>"}
    - log: 'position.opened' {side: "long", filledQty: "<partial qty>"}
    - log: 'order.placed' {kind: "sl"}
    - log: 'order.placed' {kind: "tp"}
    - db:intentLifecycleEvents partially_filled→filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:2625 (delayToExpiry setup)
    - src/execution/execution/manager.ts:2629 (limit entry expired log)
    - src/execution/execution/manager.ts:2637 (s.filledQty > 0 branch)
    - src/execution/execution/manager.ts:2639 (transition filled)
    - src/execution/execution/manager.ts:2640 (handleEntryFilled call)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (partial fill at expiry — handleEntryFilled with partial qty)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    cancelOrder is best-effort (catch swallowed at line 2634). The partial fill quantity
    is used for SL/TP sizing. Position may be smaller than intent.volume.

- id: strategy_4_2a.binance.ORDER_LIFECYCLE.LIMIT_NEVER_FILLS_EXPIRED
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    The expiry timer fires at deadlineAt. The limit order has not filled at all (s.filledQty=0).
    Manager cancels the limit and transitions intent to error with code=limit_expired.
    No position was opened; no SL/TP placed.
  preconditions:
    - entry limit order in status=working with filledQty=0
    - expiry timer fires at deadlineAt
  trigger_sequence:
    - setTimeout callback at delayToExpiry fires
    - TERMINAL check: not terminal, not filled/monitoring
    - s.filledQty === 0 path taken
    - rest.cancelOrder called
    - setError(s, 'limit_expired', ...)
  expected_behavior:
    - log: 'limit entry expired — cancelling unfilled limit'
    - no order.filled log
    - intent.error logged with code=limit_expired
    - status transitions working → error (terminal)
    - no position opened on Binance
  observability_contract:
    - log: 'limit entry expired — cancelling unfilled limit' {intentId}
    - log: 'intent.error' {code: "limit_expired", exchange: "binance"}
    - db:intentLifecycleEvents working→error
    - db:orders entry row with status=cancelled (or pending if cancel ACK not processed)
    - no db:orders sl/tp rows for this intentId
  code_refs:
    - src/execution/execution/manager.ts:2629 (limit entry expired log)
    - src/execution/execution/manager.ts:2637 (filledQty check)
    - src/execution/execution/manager.ts:2642 (setError limit_expired)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (limit_expired — undocumented in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    This is the most important failure mode to validate. If price does not drop to the
    limit level by deadlineAt, no trade occurs. This is undocumented in the spec — the
    spec does not define what happens if the limit never fills. Code terminates with
    limit_expired error.

- id: strategy_4_2a.binance.ORDER_LIFECYCLE.SL_PLACEMENT_FAILS_AFTER_FILL
  category: ORDER_LIFECYCLE
  severity: high
  description: >
    Limit order fills. handleEntryFilled runs. REST createOrder for SL or TP fails
    (exchange rejects or network error). Manager detects rejection via ackRejectReason,
    logs protective order placement failed, then calls closeAfterProtectionFailure to
    market-close the position immediately.
  preconditions:
    - limit entry filled (status=filled)
    - SL or TP createOrder rejects
  trigger_sequence:
    - Promise.allSettled([rest.createOrder(sl), rest.createOrder(tp)]) settles
    - slReject or tpReject is non-null
    - closeAfterProtectionFailure called
  expected_behavior:
    - log: 'manager: protective order placement failed' {slReject, tpReject}
    - protective close placed immediately (market SELL reduceOnly)
    - intent exits via protective close path
  observability_contract:
    - log: 'manager: protective order placement failed' {intentId, slReject, tpReject}
    - log: 'order.placed' {kind: "close", orderType: "market", reduceOnly: true}
    - db:intentLifecycleEvents filled→exiting→exited (or error)
  code_refs:
    - src/execution/execution/manager.ts:498 (Promise.allSettled sl+tp)
    - src/execution/execution/manager.ts:523 (ackRejectReason check)
    - src/execution/execution/manager.ts:538 (protective order placement failed log)
    - src/execution/execution/manager.ts:539 (closeAfterProtectionFailure)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (no error handling in spec)
  status: ⏳
  natural_occurrence: rare
  notes: >
    Binance returns -2021 (Order would immediately trigger) if stopPrice is invalid.
    This triggers the protective close path to prevent an unprotected long position.

# ── TIMING ──────────────────────────────────────────────────────────────────

- id: strategy_4_2a.binance.TIMING.LIMIT_PLACED_AT_CORRECT_OFFSET
  category: TIMING
  severity: high
  description: >
    Limit entry order is placed at approximately T_f - entryOffsetSeconds (default 5s).
    The scheduler fires evaluate(), strategy_4_2a.evaluate() returns the intent with
    entryAt = nextFundingTimestamp - entryOffsetSeconds * 1000. Elapsed from entryAt
    to order.placed should be within ≤2000ms (REST + setLeverage).
  preconditions:
    - scheduler running and synced to exchange clock
    - strategy condition met
  trigger_sequence:
    - scheduler fires evaluate() at entryAt
  expected_behavior:
    - intent.submitted timestamp within ≤1000ms after entryAt
    - order.placed (limit) timestamp within ≤2000ms after entryAt
    - limitPrice = price * (1 - priceOffsetPct/100) computed correctly
  observability_contract:
    - log: 'intent.submitted' timestamp ≤ entryAt + 1000ms
    - log: 'order.placed (limit)' {limitPrice} timestamp ≤ entryAt + 2000ms
    - db:orders {kind: "entry", orderType: "limit"} createdAt within [entryAt, entryAt + 2000ms]
  code_refs:
    - src/execution/strategies/strategy_4_2a.ts:64 (entryAt = nextFundingTimestamp - entryOffsetSeconds*1000)
    - src/execution/strategies/strategy_4_2a.ts:44 (priceOffsetPct = absF * limitOffsetMult)
    - src/execution/execution/manager.ts:2552 (limitPrice calculation)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (Limit placed at T_f - 5s)
  status: ⏳
  natural_occurrence: routine
  notes: >
    The limit price is dynamic: priceOffsetPct = |fundingRatePercent| * limitOffsetMult.
    A 0.6% funding rate with limitOffsetMult=0.5 gives a 0.3% offset below current price.

- id: strategy_4_2a.binance.TIMING.LIMIT_FILLS_AFTER_FUNDING_SETTLEMENT
  category: TIMING
  severity: high
  description: >
    The limit order rests in the book through T_funding. After the funding settlement,
    price drops toward the limit level. The fill event arrives via WS after T_f.
    Verify that the fill is detected and SL/TP are placed promptly.
  preconditions:
    - entry limit order in working state at T_f
    - price drops to limit level after T_f
  trigger_sequence:
    - ORDER_TRADE_UPDATE X=FILLED arrives after T_f
  expected_behavior:
    - order.filled timestamp > nextFundingTimestamp
    - SL/TP placed within ≤2000ms of order.filled
    - monitor.armed.sl_tp_deadline with deadlineDelay = deadlineAt - now
  observability_contract:
    - log: 'order.filled' timestamp > nextFundingTimestamp
    - log: 'order.placed' (sl) timestamp within ≤2000ms of order.filled
    - log: 'order.placed' (tp) timestamp within ≤2000ms of order.filled
    - log: 'monitor.armed.sl_tp_deadline' {deadlineDelay: ">0"} (debug)
  code_refs:
    - src/execution/execution/monitor.ts:112 (deadlineDelay = deadlineAt - now - skewMs)
    - src/execution/execution/monitor.ts:114 (monitor.deadline_fired)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (post-funding fill scenario A)
  status: ⏳
  natural_occurrence: routine
  notes: >
    This is the intended scenario — the limit fills AFTER T_funding during the price
    dip. If price drops before T_f, the limit may fill early (still valid behavior).

- id: strategy_4_2a.binance.TIMING.EXPIRY_TIMER_FIRES_AT_DEADLINE
  category: TIMING
  severity: critical
  description: >
    expireAt = deadlineAt = T_f + deadlineSeconds. The expiry timer (setTimeout) fires
    at delayToExpiry = max(0, deadlineAt - clock.now()). If the limit has not filled
    by this point, it is cancelled and either limit_expired error is set (no fills) or
    handleEntryFilled runs (partial fills).
  preconditions:
    - entry limit in working state with no full fill by deadlineAt
  trigger_sequence:
    - setTimeout fires at deadlineAt
  expected_behavior:
    - 'limit entry expired — cancelling unfilled limit' logged at deadlineAt ± timer resolution
    - cancelOrder called
    - either limit_expired error or handleEntryFilled (if partial)
  observability_contract:
    - log: 'limit entry expired — cancelling unfilled limit' {intentId}
    - timestamp of log within ±500ms of deadlineAt
  code_refs:
    - src/execution/execution/manager.ts:2625 (delayToExpiry = max(0, expireAt - clock.now()))
    - src/execution/execution/manager.ts:2626 (setTimeout)
    - src/execution/execution/manager.ts:2629 (limit entry expired log)
    - src/execution/strategies/strategy_4_2a.ts:45 (deadlineAt = nextFundingTimestamp + deadlineSeconds*1000)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (expireAt = deadlineAt — undocumented)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Note: expireAt === deadlineAt for strategy_4_2a (same timestamp). The deadline for
    the monitoring phase (monitor.deadline_fired) and the limit expiry are the same moment.
    If the limit fills just before deadlineAt, both the monitoring deadline timer and the
    expiry timer may fire; the TERMINAL guard prevents double-handling.

- id: strategy_4_2a.binance.TIMING.MONITORING_DEADLINE_FIRES
  category: TIMING
  severity: critical
  description: >
    Limit fills. SL+TP placed. Monitor deadline timer fires at deadlineAt. Monitor calls
    settle('deadline', ...) which triggers handleMonitorExit. Manager cancels SL+TP and
    places a market SELL reduce-only close order (kind=close).
  preconditions:
    - intent in monitoring state
    - neither SL nor TP has filled before deadlineAt
  trigger_sequence:
    - monitor deadline setTimeout fires
    - monitor.deadline_fired logged
    - monitor.settle logged (reason=deadline)
    - handleMonitorExit(s, 'deadline') called
  expected_behavior:
    - monitor.deadline_fired logged
    - monitor.settle logged (reason=deadline)
    - intent.exiting.start logged (reason=deadline)
    - SL + TP cancelOrder called (best-effort)
    - market close order placed (kind=close, side=sell, orderType=market, reduceOnly=true)
    - order.placed logged for close
  observability_contract:
    - log: 'monitor.deadline_fired' {intentId, deadlineAt}
    - log: 'monitor.settle' {reason: "deadline"}
    - log: 'intent.exiting.start' {reason: "deadline"}
    - log: 'order.placed' {kind: "close", side: "sell", orderType: "market", reduceOnly: true}
    - db:orders {kind: "close", orderType: "market"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:113 (deadlineHandle setTimeout)
    - src/execution/execution/monitor.ts:114 (monitor.deadline_fired log)
    - src/execution/execution/monitor.ts:93 (monitor.settle log)
    - src/execution/execution/manager.ts:1479 (intent.exiting.start log)
    - src/execution/execution/manager.ts:1578 (cancel sl+tp refs)
    - src/execution/execution/manager.ts:1585 (closeKind = close for deadline)
    - src/execution/execution/manager.ts:1660 (order.placed close log)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (deadline fires → cancel SL/TP, market close)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    closeKind is 'close' (not 'timed') when reason='deadline'. See manager.ts:1585.

# ── OCO ─────────────────────────────────────────────────────────────────────

- id: strategy_4_2a.binance.OCO.SL_FIRES_TP_CANCELED
  category: OCO
  severity: critical
  description: >
    Price drops below SL stop price after limit fills. Binance triggers the stop_market
    SL order. WS ORDER_TRADE_UPDATE arrives with X=FILLED for the SL clientOrderId.
    Monitor detects via ws.order listener, settles reason=sl. handleMonitorExit cancels
    the resting TP limit order, sweeps reduce-only orders, transitions to exited.
  preconditions:
    - intent in monitoring state
    - SL and TP orders placed and resting
    - price drops below SL stop price
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {X: "FILLED", c: <slClientOrderId>}
    - monitor ws.order listener: order.clientOrderId === slId → settle('sl', ctx)
    - handleMonitorExit(s, 'sl')
  expected_behavior:
    - monitor.settle logged (reason=sl, source=ws)
    - intent.exiting.start logged (reason=sl)
    - TP cancelOrder called (best-effort)
    - sweepReduceOnlyOrders called
    - intent.exited.complete logged (reason=sl)
    - status transitions monitoring → exiting → exited
  observability_contract:
    - log: 'monitor.settle' {reason: "sl", source: "ws"}
    - log: 'intent.exiting.start' {reason: "sl"}
    - log: 'intent.exited.complete' {exitReason: "sl"}
    - db:intentLifecycleEvents monitoring→exiting→exited
    - db:orders {kind: "tp", status: "cancelled"}
  code_refs:
    - src/execution/execution/monitor.ts:127 (slId match → settle sl)
    - src/execution/execution/monitor.ts:93 (monitor.settle log)
    - src/execution/execution/manager.ts:1479 (intent.exiting.start)
    - src/execution/execution/manager.ts:1502 (sl reason → cancel tp residual)
    - src/execution/execution/manager.ts:1561 (sweepReduceOnlyOrders)
    - src/execution/execution/manager.ts:1565 (intent.exited.complete log)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (SL fires → TP canceled → exit reason=sl)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    Binance stop_market fill arrives via ORDER_TRADE_UPDATE. The clientOrderId on the
    triggered market order matches the original stop order's clientOrderId on Binance.

- id: strategy_4_2a.binance.OCO.TP_FILLS_SL_CANCELED
  category: OCO
  severity: critical
  description: >
    Price rises above TP limit price after limit fills. TP limit order fills.
    WS ORDER_TRADE_UPDATE arrives with X=FILLED for the TP clientOrderId.
    Monitor settles reason=tp. handleMonitorExit cancels the resting SL stop_market.
  preconditions:
    - intent in monitoring state
    - SL and TP orders placed and resting
    - price rises above TP price
  trigger_sequence:
    - Binance WS: ORDER_TRADE_UPDATE {X: "FILLED", c: <tpClientOrderId>}
    - monitor ws.order listener: order.clientOrderId === tpId → settle('tp', ctx)
    - handleMonitorExit(s, 'tp')
  expected_behavior:
    - monitor.settle logged (reason=tp, source=ws)
    - intent.exiting.start logged (reason=tp)
    - SL cancelOrder called (best-effort)
    - intent.exited.complete logged (reason=tp)
    - status transitions monitoring → exiting → exited
  observability_contract:
    - log: 'monitor.settle' {reason: "tp", source: "ws"}
    - log: 'intent.exiting.start' {reason: "tp"}
    - log: 'intent.exited.complete' {exitReason: "tp"}
    - db:intentLifecycleEvents monitoring→exiting→exited
    - db:orders {kind: "sl", status: "cancelled"}
  code_refs:
    - src/execution/execution/monitor.ts:136 (tpId match → settle tp)
    - src/execution/execution/manager.ts:1502 (tp reason → cancel sl residual)
    - src/execution/execution/manager.ts:1565 (intent.exited.complete log)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (TP fills → SL canceled → exit reason=tp)
  status: ⏳
  natural_occurrence: occasional

- id: strategy_4_2a.binance.OCO.DEADLINE_CANCELS_BOTH_MARKET_CLOSE
  category: OCO
  severity: critical
  description: >
    Deadline timer fires while SL and TP are both still open (neither has filled).
    handleMonitorExit(s, 'deadline') cancels both SL and TP, then places a market
    SELL reduce-only close order to flatten the position.
  preconditions:
    - intent in monitoring state
    - SL and TP resting and unfilled at deadlineAt
  trigger_sequence:
    - monitor deadline setTimeout fires → settle('deadline', ...)
    - handleMonitorExit(s, 'deadline')
    - cancel SL ref, cancel TP ref
    - place market close (kind=close, side=sell)
  expected_behavior:
    - SL and TP cancel attempted
    - market close order placed (kind=close, orderType=market, reduceOnly=true)
    - close fill detected via WS or REST poll
    - intent transitions to exited
  observability_contract:
    - log: 'monitor.deadline_fired'
    - log: 'monitor.settle' {reason: "deadline"}
    - log: 'intent.exiting.start' {reason: "deadline"}
    - log: 'order.placed' {kind: "close", orderType: "market", reduceOnly: true}
    - db:orders {kind: "close", status: "filled"}
    - db:intentLifecycleEvents monitoring→exiting→exited
  code_refs:
    - src/execution/execution/monitor.ts:114 (monitor.deadline_fired)
    - src/execution/execution/manager.ts:1578 (cancel sl+tp loop)
    - src/execution/execution/manager.ts:1585 (closeKind = close)
    - src/execution/execution/manager.ts:1609 (createOrder market close)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (deadline → cancel SL/TP, market close)
  status: ⏳
  natural_occurrence: occasional

# ── WEBSOCKET ────────────────────────────────────────────────────────────────

- id: strategy_4_2a.binance.WEBSOCKET.LIMIT_FILL_DETECTED_VIA_WS
  category: WEBSOCKET
  severity: critical
  description: >
    Binance WS private stream emits ORDER_TRADE_UPDATE with X=FILLED for the resting
    limit entry order. The adapter parses this via mapOrderTradeUpdate, emits ws.order
    event. Manager byEntryOrderId lookup matches clientOrderId (field 'c'), routes to
    handleEntryOrderEvent, transitions to filled, places SL+TP.
  preconditions:
    - entry limit order in working state
    - Binance private WS connected
    - price hits limit level
  trigger_sequence:
    - Binance WS: {e: "ORDER_TRADE_UPDATE", X: "FILLED", c: <clientOrderId>}
    - binance.ts:parseBinanceMessage maps to order event
    - ws.order bus event emitted
    - byEntryOrderId.get(canonEntryId) returns intentId
  expected_behavior:
    - order.filled logged
    - expiry timer TERMINAL guard fires first (idempotent if timer fires after WS fill)
    - SL+TP placed
    - monitor armed
  observability_contract:
    - log: 'order.filled' {exchange: "binance"} (from WS, before expiry timer fires)
    - log: 'order.placed' {kind: "sl"}
    - log: 'order.placed' {kind: "tp"}
  code_refs:
    - src/execution/adapters/privatews/binance.ts:48 (ORDER_TRADE_UPDATE → mapOrderTradeUpdate)
    - src/execution/execution/manager.ts:1898 (ws.order bus handler)
    - src/execution/execution/manager.ts:1136 (handleEntryOrderEvent fill branch)
    - src/execution/execution/manager.ts:2628 (TERMINAL guard in expiry timer)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (WS fill detection)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Binance WS fill for limit orders is reliable. The concurrent pollForEntryFill REST
    poll (15×1s) also runs but the WS typically wins. When WS fires first, the poll
    sees status != working and returns early (idempotent).

- id: strategy_4_2a.binance.WEBSOCKET.WS_MISSED_FILL_REST_POLL_FALLBACK
  category: WEBSOCKET
  severity: high
  description: >
    WS ORDER_TRADE_UPDATE for the limit fill does not arrive (brief WS gap). The REST
    pollForEntryFill loop (15 polls × 1s) detects the fill via getOrder and drives the
    intent through handleEntryOrderEvent → filled → SL+TP placed → monitoring.
    On Binance, REST poll runs concurrently with WS (started at manager.ts:2649).
  preconditions:
    - entry limit order placed and in status=working
    - WS fill event not received
  trigger_sequence:
    - pollForEntryFill: rest.getOrder returns status=filled
    - handleEntryOrderEvent(s, order) called from poll
  expected_behavior:
    - order.filled logged (from poll path)
    - SL+TP placed
    - pollForEntryFill exits (status no longer working)
    - monitor armed
  observability_contract:
    - log: 'order.filled' (emitted from poll, not WS handler — no distinguishing log field)
    - log: 'order.placed' {kind: "sl"}
    - log: 'order.placed' {kind: "tp"}
    - db:intentLifecycleEvents working→filled→monitoring
  code_refs:
    - src/execution/execution/manager.ts:2647 (poll started concurrently)
    - src/execution/execution/manager.ts:1179 (pollForEntryFill 15×1s)
    - src/execution/execution/manager.ts:1193 (rest.getOrder call)
    - src/execution/execution/manager.ts:1194 (handleEntryOrderEvent from poll)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (no poll fallback in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    On Binance, WS fill is highly reliable. The REST poll is primarily a safety net.
    Note that Binance REST poll runs immediately after order placement (not only on WS gap).

- id: strategy_4_2a.binance.WEBSOCKET.WS_RECONNECT_LIMIT_STILL_OPEN
  category: WEBSOCKET
  severity: high
  description: >
    Binance private WS disconnects and reconnects while the limit entry order is still
    open (status=working). store.reconcile() is called, fetching open orders and positions
    via REST. The resting limit is still in byEntryOrderId map. No duplicate or spurious
    fill is triggered. The expiry timer continues unaffected.
  preconditions:
    - intent in status=working (limit resting in order book)
    - WS disconnects then reconnects
  trigger_sequence:
    - ws.connection event: {state: "disconnected"}
    - ws.connection event: {state: "connected"}
    - store.reconcile() called
  expected_behavior:
    - store.reconcile fetches open orders; limit order confirmed still open
    - byEntryOrderId map still intact
    - expiry timer still armed (setTimeout not reset)
    - pollForEntryFill still running (may re-detect via next REST poll cycle)
    - no duplicate order.filled log
  observability_contract:
    - bus: 'ws.connection' {state: "connected"} (internal event — no logger.info)
    - log: event='ws.connection' {exchange: "binance", state: "connected", prevState: "reconnecting"|"disconnected", downtimeMs: ">0"}
    - no spurious 'order.filled' log during reconnect
    - state maps updated (positions, balances)
  code_refs:
    - src/execution/state/store.ts:214 (ws.connection listener)
    - src/execution/state/store.ts:219 (store.reconcile on reconnect)
    - src/execution/execution/manager.ts:2625 (expiry timer — not reset on reconnect)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (no WS reconnect behavior in spec)
  status: ⏳
  natural_occurrence: occasional

# ── RECOVERY ────────────────────────────────────────────────────────────────

- id: strategy_4_2a.binance.RECOVERY.RESTART_WITH_LIMIT_OPEN
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while a strategy_4_2a limit entry order is open (status=working).
    Recovery rehydrates the IntentState from DB, restores byEntryOrderId map (entry order
    row with kind=entry, status=pending). pollForEntryFill is NOT automatically restarted
    by recovery — the rehydrated intent waits for a WS fill event. No expiry timer is
    re-armed by recovery for working intents.
  preconditions:
    - intent in DB with status=working (or acked)
    - entry order row {kind: "entry", orderType: "limit", status: "pending"} in DB
    - deadlineAt in the future
  trigger_sequence:
    - process restart
    - runRecovery() called
    - intentRows loaded; byEntryOrderId restored for entry order clientOrderId
  expected_behavior:
    - 'recovery: rehydrated intent states' logged (rehydratedCount ≥ 1)
    - byEntryOrderId map has the limit order's canonicalized clientOrderId
    - WS fill event (if received after reconnect) routes correctly to handleEntryOrderEvent
    - expiry timer is NOT re-armed (gap: process restart resets setTimeout)
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: "≥1"}
    - no 'intent.exiting.start' immediately after recovery (intent stays in working)
    - WS ORDER_TRADE_UPDATE fill detected and processed normally after reconnect
  code_refs:
    - src/execution/recovery/index.ts:140 (loadActiveIntents)
    - src/execution/recovery/index.ts:181 (byEntryOrderId.set from entry order row)
    - src/execution/recovery/index.ts:245 (rehydrated intent states log)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (no recovery in spec)
  status: ⏳
  natural_occurrence: occasional
  notes: >
    CRITICAL GAP: the expiry timer (setTimeout) is NOT re-armed during recovery for
    working intents. If the process restarts while the limit is open, the timer that
    would fire at deadlineAt is lost. The intent can remain stuck in working state
    indefinitely if the WS fill never arrives and no manual intervention occurs.

- id: strategy_4_2a.binance.RECOVERY.RESTART_IN_MONITORING
  category: RECOVERY
  severity: critical
  description: >
    Process restarts while intent is in monitoring state (limit filled, SL+TP resting).
    Recovery rehydrates state, restores exitOrderRefs (sl/tp). manager.start() re-arms
    the sl_tp_deadline monitor for all monitoring intents. SL/TP WS listener and deadline
    timer re-established. pollForSlTpFill also restarted.
  preconditions:
    - intent in DB with status=monitoring
    - exitPolicy.kind=sl_tp_deadline, deadlineAt in the future
    - SL and TP order rows in DB
  trigger_sequence:
    - process restart → runRecovery() → manager.start() re-arms monitoring intents
  expected_behavior:
    - 'recovery: rehydrated intent states' logged
    - monitor.armed.sl_tp_deadline logged (deadlineDelay recalculated from now)
    - SL/TP WS listener re-established
    - pollForSlTpFill restarted
    - if SL/TP already filled before restart, next poll detects it and exits
  observability_contract:
    - log: 'recovery: rehydrated intent states' {rehydratedCount: "≥1"}
    - log: 'monitor.armed.sl_tp_deadline' {deadlineDelay: ">0"} (debug)
    - monitor continues normally after restart
  code_refs:
    - src/execution/recovery/index.ts:245 (rehydrated intent states log)
    - src/execution/execution/manager.ts:1888 (start — re-arm monitoring intents)
    - src/execution/execution/manager.ts:1892 (monitor.arm for status=monitoring)
    - src/execution/execution/manager.ts:784 (pollForSlTpFill started after handleEntryFilled)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (no recovery in spec)
  status: ⏳
  natural_occurrence: occasional

# ── STRATEGY_SPECIFIC ────────────────────────────────────────────────────────

- id: strategy_4_2a.binance.STRATEGY_SPECIFIC.LIMIT_PRICE_BELOW_CURRENT
  category: STRATEGY_SPECIFIC
  severity: high
  description: >
    The limit entry price is computed as P_current × (1 - priceOffsetPct/100), placing it
    BELOW the current market price. Verify that the limit price is correctly set below the
    best ask at placement time, and that the order rests as a resting limit (not immediately
    matched). This is the fundamental difference from strategy_1's market entry.
  preconditions:
    - refPrice available at submit time
    - priceOffsetPct = absF * limitOffsetMult > 0
  trigger_sequence:
    - manager.submit() computes limitPrice from refPrice and priceOffsetPct
    - REST createOrder with type=limit and price=limitPrice
  expected_behavior:
    - limitPrice < current bid/ask spread
    - Binance ACKs the limit order without immediate fill (status=NEW)
    - order rests in book
  observability_contract:
    - log: 'order.placed (limit)' {limitPrice: "<current_price * (1 - offset)"} (verify arithmetic)
    - db:orders {orderType: "limit", price: "<limitPrice>"}
    - Binance REST: GET /fapi/v1/order shows status=NEW
  code_refs:
    - src/execution/execution/manager.ts:2552 (limitPrice = price * (1 - priceOffsetPct / 100))
    - src/execution/strategies/strategy_4_2a.ts:44 (priceOffsetPct = absF * limitOffsetMult)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (limit below current price)
  status: ⏳
  natural_occurrence: routine

- id: strategy_4_2a.binance.STRATEGY_SPECIFIC.SL_TP_ANCHORED_TO_FILL_PRICE
  category: STRATEGY_SPECIFIC
  severity: critical
  description: >
    SL and TP prices are anchored to avgFillPrice (the actual limit fill price), not
    to the pre-trade reference price. slPrice = avgFillPrice * (1 - slPct/100),
    tpPrice = avgFillPrice * (1 + tpPct/100). slPct = absF * slMultiplier.
    Verify that SL/TP placement uses the fill price, not refPrice.
  preconditions:
    - limit order filled (avgFillPrice available on order event)
  trigger_sequence:
    - handleEntryFilled: price = s.avgEntryPrice ?? refPrice(...)
    - s.avgEntryPrice is set from order.avgFillPrice on fill event
  expected_behavior:
    - slPrice = fill_price * (1 - slPct/100) (lower than fill price for long)
    - tpPrice = fill_price * (1 + tpPct/100) (higher than fill price for long)
    - Verify fill price != pre-trade ref price (limit filled below original ref price)
  observability_contract:
    - log: 'order.placed' {kind: "sl", stopPrice: "<fill_price * (1-slPct/100))"}
    - log: 'order.placed' {kind: "tp", price: "<fill_price * (1+tpPct/100))"}
    - db:orders {kind: "sl"} stopPrice derived from actual fill price
  code_refs:
    - src/execution/execution/manager.ts:411 (price = s.avgEntryPrice ?? refPrice(...))
    - src/execution/execution/manager.ts:458 (slPrice/tpPrice calculation)
    - src/execution/execution/manager.ts:1153 (avgFillPrice set on fill event)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (SL/TP anchored to fill price)
  status: ⏳
  natural_occurrence: routine
  notes: >
    Since the limit fills BELOW the pre-trade price, SL and TP are tighter than they
    would be if anchored to refPrice. This is correct behavior per spec.

# ── SPEC_DIVERGENCE ──────────────────────────────────────────────────────────

- id: strategy_4_2a.binance.SPEC_DIVERGENCE.KILL_SWITCH_BLOCKS_ENTRY
  category: SPEC_DIVERGENCE
  severity: high
  description: >
    Kill switch is active when strategy_4_2a would otherwise submit a limit entry.
    Preflight rejects the intent with code=kill_switch before any REST call.
    The spec has no mention of a kill switch.
  preconditions:
    - kill switch mode != 'off'
    - strategy_4_2a condition met (threshold, balance, market, refPrice)
  trigger_sequence:
    - manager.submit() → preflight → killSwitch.canPlaceOrder() returns false
  expected_behavior:
    - intent.created logged (decided status)
    - intent.error logged with code=kill_switch
    - no limit order placed on Binance
    - no order.placed (limit) log
  observability_contract:
    - log: 'intent.error' {code: "kill_switch"}
    - log: event='preflight.rejected' {rejectionCode: "kill_switch"}
    - db:intentLifecycleEvents decided→error
    - db:orders no entry for this intentId
  code_refs:
    - src/execution/execution/preflight.ts:32 (kill switch check)
    - src/execution/risk/kill-switch.ts (KillSwitch implementation)
  spec_refs:
    - docs-strategy/strategies/strategy_4_2.md (no kill switch mentioned)
  status: ⏳
  natural_occurrence: occasional
```
