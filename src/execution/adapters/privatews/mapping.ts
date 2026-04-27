import type { Exchange } from '../../types/exchange.js'
import type { Order, OrderSide, OrderStatus, OrderType, Position, Balance } from '../rest/types.js'
import type { OrderEvent, PositionEvent, BalanceEvent, FundingFeeEvent } from './types.js'

export interface BinanceOrderUpdateRaw {
  e: 'ORDER_TRADE_UPDATE'
  E: number
  T: number
  o: {
    s: string
    c: string
    S: string
    o: string
    q: string
    p: string
    ap: string
    sp: string
    X: string
    i: number
    z: string
    R: boolean
    T: string | number
  }
}

export interface BinanceAccountBalanceRaw {
  a: string
  wb: string
  cw: string
  bc: string
}

export interface BinanceAccountPositionRaw {
  s: string
  pa: string
  ep: string
  up: string
  ps: string
}

export interface BinanceAccountUpdateRaw {
  e: 'ACCOUNT_UPDATE'
  E: number
  T: number
  a: {
    m: string
    B: BinanceAccountBalanceRaw[]
    P: BinanceAccountPositionRaw[]
  }
}

function mapWsOrderStatus(x: string): OrderStatus {
  switch (x.toUpperCase()) {
    case 'NEW':
      return 'new'
    case 'PARTIALLY_FILLED':
      return 'partially_filled'
    case 'FILLED':
      return 'filled'
    case 'CANCELED':
    case 'CANCELLED':
      return 'cancelled'
    case 'REJECTED':
      return 'rejected'
    case 'EXPIRED':
      return 'expired'
    default:
      return 'new'
  }
}

function mapWsOrderType(o: string): OrderType {
  switch (o.toUpperCase()) {
    case 'LIMIT':
      return 'limit'
    case 'STOP_MARKET':
    case 'TAKE_PROFIT_MARKET':
      return 'stop_market'
    default:
      return 'market'
  }
}

export function mapOrderTradeUpdate(
  raw: BinanceOrderUpdateRaw,
  receivedAt: number,
  seq: number,
  exchange: Exchange = 'binance'
): OrderEvent {
  const o = raw.o
  const order: Order = {
    exchange,
    symbol: o.s,
    clientOrderId: o.c,
    exchangeOrderId: String(o.i),
    side: o.S.toLowerCase() as OrderSide,
    type: mapWsOrderType(o.o),
    qty: parseFloat(o.q),
    filledQty: parseFloat(o.z),
    reduceOnly: o.R,
    status: mapWsOrderStatus(o.X),
    submittedAt: raw.T,
    updatedAt: Number(o.T) || raw.T,
  }
  const price = parseFloat(o.p)
  if (price > 0) order.price = price
  const avgFill = parseFloat(o.ap)
  if (avgFill > 0) order.avgFillPrice = avgFill
  const stopPrice = parseFloat(o.sp)
  if (stopPrice > 0) order.stopPrice = stopPrice
  return { exchange, order, seq, receivedAt }
}

export function mapAccountUpdate(
  raw: BinanceAccountUpdateRaw,
  receivedAt: number,
  seq: number,
  exchange: Exchange = 'binance'
): { balances: BalanceEvent[]; positions: PositionEvent[] } {
  const balances: BalanceEvent[] = raw.a.B.map(b => {
    const balance: Balance = {
      exchange,
      asset: b.a,
      available: parseFloat(b.cw),
      locked: Math.max(0, parseFloat(b.wb) - parseFloat(b.cw)),
      updatedAt: raw.T,
    }
    return { exchange, balance, seq, receivedAt }
  })

  const positions: PositionEvent[] = raw.a.P.map(p => {
    const pa = parseFloat(p.pa)
    const position: Position = {
      exchange,
      symbol: p.s,
      qty: Math.abs(pa),
      side: pa > 0 ? 'long' : pa < 0 ? 'short' : 'flat',
      leverage: 1,
      updatedAt: raw.T,
    }
    const ep = parseFloat(p.ep)
    if (ep > 0) position.entryPrice = ep
    const up = parseFloat(p.up)
    if (!isNaN(up)) position.unrealizedPnl = up
    return { exchange, position, seq, receivedAt }
  })

  return { balances, positions }
}

export function mapFundingFee(
  raw: BinanceAccountUpdateRaw,
  receivedAt: number,
  _seq: number,
  exchange: Exchange = 'binance'
): FundingFeeEvent | null {
  if (raw.a.m !== 'FUNDING_FEE') return null
  const firstPos = raw.a.P[0]
  const firstBal = raw.a.B[0]
  if (!firstPos || !firstBal) return null
  return {
    exchange,
    symbol: firstPos.s,
    fundingTime: raw.T,
    fundingRate: 0,
    fundingAmount: parseFloat(firstBal.bc),
    asset: firstBal.a,
    positionQty: Math.abs(parseFloat(firstPos.pa)),
    receivedAt,
  }
}
