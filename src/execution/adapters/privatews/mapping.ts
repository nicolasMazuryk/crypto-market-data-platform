import type { Exchange } from '../../types/exchange.js'
import type { Order, OrderSide, OrderStatus, OrderType, Position, Balance } from '../rest/types.js'
import type { OrderEvent, PositionEvent, BalanceEvent, FundingFeeEvent, FillEvent } from './types.js'
import type { FundingRateCache } from './funding-rate-cache.js'

export interface BinanceOrderUpdateRaw {
  e: 'ORDER_TRADE_UPDATE'
  E: number
  T: number
  o: {
    s: string
    c: string
    /** Original client order id — populated on cancel/replace and some FILLED events where c is empty. */
    C?: string
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
    l?: string
    L?: string
    n?: string
    N?: string
    m?: boolean
    t?: number
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
  exchange: Exchange = 'binance',
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): OrderEvent {
  const o = raw.o
  const clientOrderId = o.c || (o.C ?? '')
  const order: Order = {
    exchange,
    symbol: o.s,
    clientOrderId,
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
  if (order.reduceOnly && order.status === 'filled' && !clientOrderId) {
    logger?.warn(
      { event: 'binance.ws.unmatched_reduce_only_fill', c: o.c, C: o.C, X: o.X, i: o.i, s: o.s },
      'binance.ws.unmatched_reduce_only_fill'
    )
  }
  return { exchange, order, seq, receivedAt }
}

export function mapFillFromOrderTradeUpdate(
  raw: BinanceOrderUpdateRaw,
  receivedAt: number,
  exchange: Exchange = 'binance'
): FillEvent | null {
  const o = raw.o
  const lastQty = parseFloat(o.l ?? '0')
  if (lastQty <= 0) return null
  if (!o.t) return null
  return {
    exchange,
    symbol: o.s,
    clientOrderId: o.c || (o.C ?? ''),
    exchangeOrderId: String(o.i),
    exchangeFillId: String(o.t),
    qty: lastQty,
    price: parseFloat(o.L ?? '0'),
    feeAsset: o.N ?? 'USDT',
    feeAmount: Math.abs(parseFloat(o.n ?? '0')),
    isMaker: o.m ?? false,
    ts: Number(o.T) || raw.T,
    receivedAt,
  }
}

export function mapAccountUpdate(
  raw: BinanceAccountUpdateRaw,
  receivedAt: number,
  seq: number,
  exchange: Exchange = 'binance'
): { balances: BalanceEvent[]; positions: PositionEvent[] } {
  const balances: BalanceEvent[] = raw.a.B.map(b => {
    const wb = parseFloat(b.wb)
    const cw = parseFloat(b.cw)
    const balance: Balance = {
      exchange,
      asset: b.a,
      available: cw,
      locked: Math.max(0, wb - cw),
      walletBalance: wb,
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
  exchange: Exchange = 'binance',
  rateCache?: FundingRateCache,
  _logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): FundingFeeEvent | null {
  if (raw.a.m !== 'FUNDING_FEE') return null
  const firstPos = raw.a.P[0]
  const firstBal = raw.a.B[0]
  if (!firstPos) {
    // P is empty — Binance omits position data in some sub-account configurations.
    // Emit with symbol:'' so the bus receives a diagnostic event; writer will skip attribution
    // and log funding.attribution.skipped_symbol_unknown. Income poller is authoritative path.
    if (!firstBal) return null
    return {
      exchange,
      symbol: '',
      fundingTime: raw.T,
      fundingRate: 0,
      fundingAmount: parseFloat(firstBal.bc),
      asset: firstBal.a,
      positionQty: 0,
      receivedAt,
    }
  }
  return {
    exchange,
    symbol: firstPos.s,
    fundingTime: raw.T,
    fundingRate: rateCache?.get(firstPos.s, raw.T) ?? 0,
    // If B[0] is absent (unusual), emit with fundingAmount=0 so the monitor can still settle.
    fundingAmount: firstBal ? parseFloat(firstBal.bc) : 0,
    asset: firstBal?.a ?? 'USDT',
    positionQty: Math.abs(parseFloat(firstPos.pa)),
    receivedAt,
  }
}
