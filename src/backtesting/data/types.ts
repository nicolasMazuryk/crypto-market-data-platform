import type { OrderbookRow } from '../../db/types.js'

export interface FundingEvent {
  exchange: string
  symbol: string
  funding_time: Date
  funding_rate: number
}

export type SkipReason = 'EMPTY_WINDOW' | 'NULL_PRICES' | 'MISSING_SECONDS' | 'PRICE_ANOMALY'

export class OHLCWindow {
  private readonly rows: OrderbookRow[]
  private readonly tsMap: Map<string, OrderbookRow>

  constructor(rows: OrderbookRow[]) {
    this.rows = rows
    this.tsMap = new Map(rows.map(r => [r.ts, r]))
  }

  get length(): number {
    return this.rows.length
  }

  getAll(): OrderbookRow[] {
    return this.rows
  }

  getRowAt(ts: string): OrderbookRow | undefined {
    return this.tsMap.get(ts)
  }

  getRowsInRange(startTs: string, endTs: string): OrderbookRow[] {
    return this.rows.filter(r => r.ts >= startTs && r.ts <= endTs)
  }

  hasTimestamp(ts: string): boolean {
    return this.tsMap.has(ts)
  }

  getFirstTs(): string | undefined {
    return this.rows[0]?.ts
  }

  getLastTs(): string | undefined {
    return this.rows[this.rows.length - 1]?.ts
  }
}
