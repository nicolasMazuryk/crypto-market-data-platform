export type OrderSide = 'buy' | 'sell'
export type OrderType = 'market' | 'limit' | 'stop'
export type FeeType = 'maker' | 'taker'

export interface Order {
  side: OrderSide
  type: OrderType
  /** For limit/stop orders: the price level */
  price?: number
  /** Quantity (normalized to 1 for backtesting) */
  quantity: number
  /** Valid from this timestamp (inclusive, ClickHouse DateTime string) */
  validFrom: string
  /** Valid until this timestamp (inclusive, ClickHouse DateTime string) */
  validUntil: string
  /** Whether this is a reduce-only order */
  reduceOnly: boolean
  /** Label for identification (e.g., "entry", "tp", "sl") */
  label: string
}

export interface Fill {
  /** Timestamp of fill (ClickHouse DateTime string) */
  timestamp: string
  /** Fill price */
  price: number
  /** Quantity filled */
  quantity: number
  /** Fee type incurred */
  feeType: FeeType
  /** Order label */
  label: string
}
