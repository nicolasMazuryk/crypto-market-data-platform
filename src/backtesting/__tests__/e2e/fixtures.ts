import type { OrderbookRow } from '../../../db/types.js'
import type { FundingEvent } from '../../data/types.js'
import { OHLCWindow } from '../../data/types.js'

/** Create a candle with specified bid/ask prices */
export function makeCandle(params: {
  ts: string
  bidOpen: number
  bidHigh?: number
  bidLow?: number
  askOpen: number
  askHigh?: number
  askLow?: number
}): OrderbookRow {
  return {
    exchange: 'binanceusdm',
    symbol: 'BTCUSDT',
    ts: params.ts,
    bid_open: params.bidOpen,
    bid_high: params.bidHigh ?? params.bidOpen * 1.0001,
    bid_low: params.bidLow ?? params.bidOpen * 0.9999,
    bid_close: params.bidOpen,
    ask_open: params.askOpen,
    ask_high: params.askHigh ?? params.askOpen * 1.0001,
    ask_low: params.askLow ?? params.askOpen * 0.9999,
    ask_close: params.askOpen,
    source_type: 'raw',
    is_interpolated: false,
    confidence_score: '1.0',
    missing_reason: null,
  }
}

/**
 * Build a complete data window with consistent prices.
 * Allows overriding specific seconds with custom candles.
 */
export function buildWindow(params: {
  fundingTime: Date
  basePrice: number
  /** Seconds before funding to start (default: 60) */
  preFunding?: number
  /** Seconds after funding to end (default: 120) */
  postFunding?: number
  /** Override candles at specific offsets from funding time */
  overrides?: Map<
    number,
    Partial<{ bidOpen: number; bidHigh: number; bidLow: number; askOpen: number; askHigh: number; askLow: number }>
  >
  /** Price function: given offset from funding time, return price. Overrides basePrice. */
  priceFn?: (offsetSeconds: number) => number
}): OHLCWindow {
  const pre = params.preFunding ?? 60
  const post = params.postFunding ?? 120
  const rows: OrderbookRow[] = []

  for (let i = -pre; i <= post; i++) {
    const ts = new Date(params.fundingTime.getTime() + i * 1000)
    const tsStr = ts.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)

    const price = params.priceFn ? params.priceFn(i) : params.basePrice
    const spread = price * 0.0001 // 0.01% spread

    const override = params.overrides?.get(i)

    rows.push(
      makeCandle({
        ts: tsStr,
        bidOpen: override?.bidOpen ?? price,
        bidHigh: override?.bidHigh ?? price + spread,
        bidLow: override?.bidLow ?? price - spread,
        askOpen: override?.askOpen ?? price + spread,
        askHigh: override?.askHigh ?? price + spread * 2,
        askLow: override?.askLow ?? price - spread * 0.5,
      })
    )
  }

  return new OHLCWindow(rows)
}

/** Create a standard funding event */
export function makeFundingEvent(params: {
  fundingTime: Date
  fundingRate: number
  exchange?: string
  symbol?: string
}): FundingEvent {
  return {
    exchange: params.exchange ?? 'binanceusdm',
    symbol: params.symbol ?? 'BTCUSDT',
    funding_time: params.fundingTime,
    funding_rate: params.fundingRate,
  }
}

/** Default fee schedule for Binance */
export const BINANCE_FEES = {
  taker_fee: 0.0004,
  maker_fee: 0.0002,
}

export const DEFAULT_SLIPPAGE = 0.0001
