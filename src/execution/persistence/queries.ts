import { eq, inArray, isNull, sql, and } from 'drizzle-orm'
import type { DrizzleDb } from './db.js'
import {
  runs,
  tradeIntents,
  orders,
  fills,
  opsEvents,
  fundingAttributions,
  type RunRow,
  type TradeIntentRow,
  type OrderRow,
  type FillRow,
  type OpsEventRow,
  type FundingAttributionRow,
} from './drizzle/schema.js'

export type { RunRow, TradeIntentRow, OrderRow, FillRow, OpsEventRow, FundingAttributionRow }

const ACTIVE_STATUSES = [
  'decided',
  'submitted',
  'acked',
  'working',
  'partially_filled',
  'filled',
  'monitoring',
  'exiting',
] as const

export async function findLatestOpenRun(db: DrizzleDb): Promise<RunRow | undefined> {
  const rows = await db
    .select()
    .from(runs)
    .where(isNull(runs.endedAt))
    .orderBy(sql`${runs.startedAt} DESC`)
    .limit(1)
  return rows[0]
}

export async function insertRun(db: DrizzleDb, row: Omit<RunRow, 'endedAt' | 'notes'>): Promise<RunRow> {
  const inserted = await db
    .insert(runs)
    .values({ ...row, endedAt: null, notes: null })
    .returning()
  if (!inserted[0]) throw new Error('insertRun: no row returned')
  return inserted[0]
}

export async function updateRunNotes(db: DrizzleDb, id: string, notes: string): Promise<void> {
  await db.update(runs).set({ notes }).where(eq(runs.id, id))
}

export async function closeRun(db: DrizzleDb, id: string): Promise<void> {
  await db.update(runs).set({ endedAt: new Date() }).where(eq(runs.id, id))
}

export async function loadActiveIntents(db: DrizzleDb, runId: string): Promise<TradeIntentRow[]> {
  return db
    .select()
    .from(tradeIntents)
    .where(and(eq(tradeIntents.runId, runId), inArray(tradeIntents.status, [...ACTIVE_STATUSES])))
}

export async function loadOrdersForIntents(db: DrizzleDb, intentIds: string[]): Promise<OrderRow[]> {
  if (intentIds.length === 0) return []
  return db.select().from(orders).where(inArray(orders.intentId, intentIds))
}

export async function loadFillsForOrders(db: DrizzleDb, orderIds: string[]): Promise<FillRow[]> {
  if (orderIds.length === 0) return []
  return db.select().from(fills).where(inArray(fills.orderId, orderIds))
}

export interface IntentLifecycle {
  intent: TradeIntentRow
  orders: OrderRow[]
  fills: FillRow[]
  fundingAttributions: FundingAttributionRow[]
  opsEvents: OpsEventRow[]
}

export async function loadIntentLifecycle(db: DrizzleDb, intentId: string): Promise<IntentLifecycle | undefined> {
  const intentRows = await db.select().from(tradeIntents).where(eq(tradeIntents.id, intentId))
  const intent = intentRows[0]
  if (!intent) return undefined

  const orderRows = await db.select().from(orders).where(eq(orders.intentId, intentId))
  const orderIds = orderRows.map(o => o.id)

  const fillRows = orderIds.length > 0 ? await db.select().from(fills).where(inArray(fills.orderId, orderIds)) : []

  const fundingRows = await db.select().from(fundingAttributions).where(eq(fundingAttributions.symbol, intent.symbol))

  const opsRows = await db
    .select()
    .from(opsEvents)
    .orderBy(sql`${opsEvents.ts} ASC`)

  return {
    intent,
    orders: orderRows,
    fills: fillRows,
    fundingAttributions: fundingRows,
    opsEvents: opsRows,
  }
}

export async function loadRunLifecycles(db: DrizzleDb, runId: string): Promise<IntentLifecycle[]> {
  const intentRows = await db.select().from(tradeIntents).where(eq(tradeIntents.runId, runId))
  if (intentRows.length === 0) return []

  const intentIds = intentRows.map(i => i.id)
  const orderRows = await loadOrdersForIntents(db, intentIds)
  const orderIds = orderRows.map(o => o.id)
  const fillRows = await loadFillsForOrders(db, orderIds)

  const fundingRows = await db
    .select()
    .from(fundingAttributions)
    .where(
      inArray(
        fundingAttributions.symbol,
        intentRows.map(i => i.symbol)
      )
    )

  const opsRows = await db
    .select()
    .from(opsEvents)
    .orderBy(sql`${opsEvents.ts} ASC`)

  const ordersByIntent = new Map<string, OrderRow[]>()
  for (const o of orderRows) {
    const arr = ordersByIntent.get(o.intentId) ?? []
    arr.push(o)
    ordersByIntent.set(o.intentId, arr)
  }

  const fillsByOrder = new Map<string, FillRow[]>()
  for (const f of fillRows) {
    const arr = fillsByOrder.get(f.orderId) ?? []
    arr.push(f)
    fillsByOrder.set(f.orderId, arr)
  }

  return intentRows.map(intent => {
    const intentOrders = ordersByIntent.get(intent.id) ?? []
    const intentFills = intentOrders.flatMap(o => fillsByOrder.get(o.id) ?? [])
    return {
      intent,
      orders: intentOrders,
      fills: intentFills,
      fundingAttributions: fundingRows.filter(f => f.symbol === intent.symbol),
      opsEvents: opsRows,
    }
  })
}
