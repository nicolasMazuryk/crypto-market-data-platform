import { pgTable, pgEnum, text, timestamp, boolean, integer, jsonb, index, unique, foreignKey } from 'drizzle-orm/pg-core'

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

export const snapshotReasonEnum = pgEnum('snapshot_reason', [
  'pre_funding',
  'post_funding',
  'reconcile',
  'exit',
  'periodic',
])

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
    status: intentStatusEnum('status').notNull().default('decided'),
    decisionReason: text('decision_reason'),
    exitPolicy: jsonb('exit_policy').notNull().default('{}'),
    fundingSnapshot: jsonb('funding_snapshot'),
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
    reduceOnly: boolean('reduce_only').notNull().default(false),
    qty: text('qty').notNull(),
    filledQty: text('filled_qty').notNull().default('0'),
    price: text('price'),
    status: orderStatusEnum('status').notNull().default('new'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
    ackedAt: timestamp('acked_at', { withTimezone: true }),
    terminalAt: timestamp('terminal_at', { withTimezone: true }),
    rawSnapshot: jsonb('raw_snapshot'),
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
  },
  table => [
    unique('uq_fills_exchange_fill_id').on(table.exchange, table.exchangeFillId),
    index('idx_fills_order_id').on(table.orderId),
  ]
)

export const positionsHistory = pgTable(
  'positions_history',
  {
    id: text('id').primaryKey(),
    exchange: text('exchange').notNull(),
    symbol: text('symbol').notNull(),
    qty: text('qty').notNull(),
    entryPrice: text('entry_price'),
    markPrice: text('mark_price'),
    leverage: integer('leverage').notNull(),
    snapshotReason: snapshotReasonEnum('snapshot_reason').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
  },
  table => [index('idx_positions_history_exchange_symbol_ts').on(table.exchange, table.symbol, table.ts)]
)

export const balancesHistory = pgTable(
  'balances_history',
  {
    id: text('id').primaryKey(),
    exchange: text('exchange').notNull(),
    asset: text('asset').notNull(),
    available: text('available').notNull(),
    locked: text('locked').notNull(),
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
  table => [index('idx_funding_attr_exchange_symbol_ts').on(table.exchange, table.symbol, table.fundingTime)]
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

export type EngineMode = typeof engineModeEnum.enumValues[number]
export type IntentStatusRow = typeof intentStatusEnum.enumValues[number]
export type OrderStatusRow = typeof orderStatusEnum.enumValues[number]
export type OpsEventLevel = typeof opsEventLevelEnum.enumValues[number]
export type SnapshotReason = typeof snapshotReasonEnum.enumValues[number]

export type RunRow = typeof runs.$inferSelect
export type TradeIntentRow = typeof tradeIntents.$inferSelect
export type OrderRow = typeof orders.$inferSelect
export type FillRow = typeof fills.$inferSelect
export type PositionsHistoryRow = typeof positionsHistory.$inferSelect
export type BalancesHistoryRow = typeof balancesHistory.$inferSelect
export type FundingAttributionRow = typeof fundingAttributions.$inferSelect
export type OpsEventRow = typeof opsEvents.$inferSelect
