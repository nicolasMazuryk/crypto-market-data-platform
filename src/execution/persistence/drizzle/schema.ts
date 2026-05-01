import { pgTable, pgEnum, text, timestamp, boolean, integer, bigint, jsonb, index, unique, foreignKey } from 'drizzle-orm/pg-core'

export const engineModeEnum = pgEnum('engine_mode', ['live', 'dry_run', 'drain_only', 'halted'])

export const intentStatusEnum = pgEnum('intent_status', [
  'decided',
  'submitted',
  'acked',
  'working',
  'partially_filled',
  'filled',
  'monitoring',
  'exiting',
  'exited',
  'error',
  'cancelled',
])

export const orderStatusEnum = pgEnum('order_status', [
  'new',
  'partially_filled',
  'filled',
  'cancelled',
  'rejected',
  'expired',
])

export const opsEventLevelEnum = pgEnum('ops_event_level', ['debug', 'info', 'warn', 'error', 'fatal'])

export const runs = pgTable('runs', {
  id: text('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  mode: engineModeEnum('mode').notNull(),
  configHash: text('config_hash').notNull().default(''),
  gitSha: text('git_sha').notNull().default(''),
  notes: text('notes'),
})

export const tradeIntents = pgTable(
  'trade_intents',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    strategy: text('strategy').notNull(),
    exchange: text('exchange').notNull(),
    symbol: text('symbol').notNull(),
    exchangeSymbol: text('exchange_symbol').notNull().default(''),
    side: text('side').notNull(),
    amountUsd: text('amount_usd').notNull(),
    leverage: integer('leverage').notNull(),
    fundingRate: text('funding_rate').notNull(),
    fundingRatePercent: text('funding_rate_percent').notNull(),
    fundingInterval: integer('funding_interval').notNull(),
    nextFundingTs: timestamp('next_funding_ts', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    entryAt: timestamp('entry_at', { withTimezone: true }),
    exitAt: timestamp('exit_at', { withTimezone: true }),
    status: intentStatusEnum('status').notNull().default('decided'),
    exitPolicy: jsonb('exit_policy').notNull().default('{}'),
    avgEntryPrice: text('avg_entry_price'),
    avgExitPrice: text('avg_exit_price'),
    exitReason: text('exit_reason'),
    entryFilledAt: timestamp('entry_filled_at', { withTimezone: true }),
    exitFilledAt: timestamp('exit_filled_at', { withTimezone: true }),
  },
  table => [
    index('idx_ti_run_exchange_status').on(table.runId, table.exchange, table.status),
    index('idx_ti_next_funding_ts').on(table.nextFundingTs),
    foreignKey({ columns: [table.runId], foreignColumns: [runs.id] }),
  ]
)

export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    intentId: text('intent_id').notNull(),
    exchange: text('exchange').notNull(),
    symbol: text('symbol').notNull(),
    clientOrderId: text('client_order_id').notNull(),
    exchangeOrderId: text('exchange_order_id'),
    side: text('side').notNull(),
    type: text('type').notNull(),
    kind: text('kind'),
    reduceOnly: boolean('reduce_only').notNull().default(false),
    qty: text('qty').notNull(),
    filledQty: text('filled_qty').notNull().default('0'),
    price: text('price'),
    stopPrice: text('stop_price'),
    intendedPrice: text('intended_price'),
    rejectionReason: text('rejection_reason'),
    exchangeSubmittedAt: timestamp('exchange_submitted_at', { withTimezone: true }),
    firstFillAt: timestamp('first_fill_at', { withTimezone: true }),
    workingAt: timestamp('working_at', { withTimezone: true }),
    status: orderStatusEnum('status').notNull().default('new'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
    ackedAt: timestamp('acked_at', { withTimezone: true }),
    terminalAt: timestamp('terminal_at', { withTimezone: true }),
  },
  table => [
    unique('uq_orders_exchange_client_order_id').on(table.exchange, table.clientOrderId),
    index('idx_orders_intent_id').on(table.intentId),
    index('idx_orders_exchange_status').on(table.exchange, table.status),
  ]
)

export const fills = pgTable(
  'fills',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    exchange: text('exchange').notNull(),
    exchangeFillId: text('exchange_fill_id').notNull(),
    qty: text('qty').notNull(),
    price: text('price').notNull(),
    feeAsset: text('fee_asset').notNull(),
    feeAmount: text('fee_amount').notNull(),
    isMaker: boolean('is_maker').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    commissionAsset: text('commission_asset'),
    commissionAmount: text('commission_amount'),
    transactionTime: timestamp('transaction_time', { withTimezone: true }),
    markPrice: text('mark_price'),
    intentId: text('intent_id'),
    orderKind: text('order_kind'),
  },
  table => [
    unique('uq_fills_exchange_fill_id').on(table.exchange, table.exchangeFillId),
    index('idx_fills_order_id').on(table.orderId),
  ]
)

export const positions = pgTable(
  'positions',
  {
    id: text('id').primaryKey(),
    intentId: text('intent_id').notNull(),
    exchange: text('exchange').notNull(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(),
    leverage: integer('leverage').notNull(),
    marginMode: text('margin_mode'),
    qty: text('qty').notNull(),
    entryPrice: text('entry_price').notNull(),
    exitPrice: text('exit_price'),
    closedVolume: text('closed_volume'),
    maxNotionalUsd: text('max_notional_usd'),
    closingPnl: text('closing_pnl'),
    tradingFeeUsd: text('trading_fee_usd'),
    fundingFeeUsd: text('funding_fee_usd'),
    realizedPnlUsd: text('realized_pnl_usd'),
    roiPct: text('roi_pct'),
    unrealizedPnl: text('unrealized_pnl'),
    liquidationPrice: text('liquidation_price'),
    effectiveLeverage: text('effective_leverage'),
    marginUsed: text('margin_used'),
    indexPrice: text('index_price'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    status: text('status').notNull().default('open'),
  },
  table => [
    unique('uq_positions_intent_id').on(table.intentId),
    index('idx_positions_exchange_symbol').on(table.exchange, table.symbol),
    foreignKey({ columns: [table.intentId], foreignColumns: [tradeIntents.id] }),
  ]
)

export const balancesHistory = pgTable(
  'balances_history',
  {
    id: text('id').primaryKey(),
    exchange: text('exchange').notNull(),
    asset: text('asset').notNull(),
    available: text('available').notNull(),
    locked: text('locked').notNull(),
    balance: text('balance'),
    unrealizedPnl: text('unrealized_pnl'),
    marginBalance: text('margin_balance'),
    equity: text('equity'),
    crossUnrealizedPnl: text('cross_unrealized_pnl'),
    reason: text('reason'),
    intentId: text('intent_id'),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
  },
  table => [index('idx_balances_history_exchange_asset_ts').on(table.exchange, table.asset, table.ts)]
)

export const fundingAttributions = pgTable(
  'funding_attributions',
  {
    id: text('id').primaryKey(),
    exchange: text('exchange').notNull(),
    symbol: text('symbol').notNull(),
    positionId: text('position_id'),
    fundingTime: timestamp('funding_time', { withTimezone: true }).notNull(),
    fundingRate: text('funding_rate').notNull(),
    fundingAmount: text('funding_amount').notNull(),
    asset: text('asset').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
  },
  table => [
    unique('uq_funding_attr').on(table.exchange, table.symbol, table.fundingTime),
    index('idx_funding_attr_exchange_symbol_ts').on(table.exchange, table.symbol, table.fundingTime),
  ]
)

export const opsEvents = pgTable(
  'ops_events',
  {
    id: text('id').primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    level: opsEventLevelEnum('level').notNull(),
    exchange: text('exchange'),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload'),
  },
  table => [
    index('idx_ops_events_ts').on(table.ts),
    index('idx_ops_events_exchange_event_type').on(table.exchange, table.eventType),
  ]
)

export const intentLifecycleEvents = pgTable(
  'intent_lifecycle_events',
  {
    id: text('id').primaryKey(),
    intentId: text('intent_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    latencyMs: integer('latency_ms'),
    context: jsonb('context'),
  },
  table => [
    index('idx_lifecycle_events_intent_ts').on(table.intentId, table.ts),
    foreignKey({ columns: [table.intentId], foreignColumns: [tradeIntents.id] }),
  ]
)

export const exitTriggers = pgTable(
  'exit_triggers',
  {
    id: text('id').primaryKey(),
    intentId: text('intent_id').notNull(),
    reason: text('reason').notNull(),
    triggerPrice: text('trigger_price'),
    triggerTs: timestamp('trigger_ts', { withTimezone: true }).notNull(),
    source: text('source').notNull(),
    exitOrderClientId: text('exit_order_client_id'),
    latencyMs: integer('latency_ms'),
    context: jsonb('context'),
  },
  table => [
    index('idx_exit_triggers_intent_id').on(table.intentId),
    foreignKey({ columns: [table.intentId], foreignColumns: [tradeIntents.id] }),
  ]
)

export const realizedPnl = pgTable(
  'realized_pnl',
  {
    intentId: text('intent_id').primaryKey(),
    exchange: text('exchange').notNull(),
    symbol: text('symbol').notNull(),
    qty: text('qty').notNull(),
    avgEntryPrice: text('avg_entry_price'),
    avgExitPrice: text('avg_exit_price'),
    grossPnl: text('gross_pnl'),
    entryFees: text('entry_fees').notNull().default('0'),
    exitFees: text('exit_fees').notNull().default('0'),
    fundingTotal: text('funding_total').notNull().default('0'),
    netPnl: text('net_pnl'),
    holdDurationMs: bigint('hold_duration_ms', { mode: 'number' }),
    exitReason: text('exit_reason'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  },
  table => [
    index('idx_realized_pnl_exchange_symbol').on(table.exchange, table.symbol),
    foreignKey({ columns: [table.intentId], foreignColumns: [tradeIntents.id] }),
  ]
)

export type EngineMode = typeof engineModeEnum.enumValues[number]
export type IntentStatusRow = typeof intentStatusEnum.enumValues[number]
export type OrderStatusRow = typeof orderStatusEnum.enumValues[number]
export type OpsEventLevel = typeof opsEventLevelEnum.enumValues[number]

export type RunRow = typeof runs.$inferSelect
export type TradeIntentRow = typeof tradeIntents.$inferSelect
export type OrderRow = typeof orders.$inferSelect
export type FillRow = typeof fills.$inferSelect
export type PositionRow = typeof positions.$inferSelect
export type BalancesHistoryRow = typeof balancesHistory.$inferSelect
export type FundingAttributionRow = typeof fundingAttributions.$inferSelect
export type OpsEventRow = typeof opsEvents.$inferSelect
export type IntentLifecycleEventRow = typeof intentLifecycleEvents.$inferSelect
export type ExitTriggerRow = typeof exitTriggers.$inferSelect
export type RealizedPnlRow = typeof realizedPnl.$inferSelect
