import type { Exchange } from '../../types/exchange.js'
import type { OrderSide, OrderStatus, Position, Balance, Order } from '../rest/types.js'
import type { OrderEvent, PositionEvent, BalanceEvent, FundingFeeEvent } from './types.js'
import type { ParsedWsMessage } from './private-ws-base.js'

interface OkxOrderData {
  ordId: string
  clOrdId?: string
  instId: string
  side: string
  ordType: string
  sz: string
  px?: string
  avgPx?: string
  state: string
  fillSz?: string
  reduceOnly?: boolean
  cTime?: string
  uTime?: string
}

interface OkxPositionData {
  instId: string
  posSide: string
  pos: string
  avgPx?: string
  upl?: string
  lever?: string
  liqPx?: string
  uTime?: string
}

interface OkxBalanceDetail {
  ccy: string
  availBal?: string
  frozenBal?: string
}

interface OkxAccountBill {
  instId?: string
  bizType?: string
  pnl?: string
  ts?: string
  sz?: string
  ccy?: string
}

interface OkxAccountData {
  details?: OkxBalanceDetail[]
  bills?: OkxAccountBill[]
}

interface OkxUpdate {
  arg?: { channel: string; instType?: string }
  data?: unknown[]
}

function mapOkxOrderStatus(state: string): OrderStatus {
  switch (state.toLowerCase()) {
    case 'live':
      return 'new'
    case 'partially_filled':
      return 'partially_filled'
    case 'filled':
      return 'filled'
    case 'cancelled':
    case 'mmp_canceled':
      return 'cancelled'
    default:
      return 'new'
  }
}

function mapOkxSide(side: string): OrderSide {
  return side.toLowerCase() === 'sell' ? 'sell' : 'buy'
}

export function parseOkxMessage(
  raw: unknown,
  receivedAt: number,
  seq: number,
  exchange: Exchange = 'okx'
): ParsedWsMessage {
  const upd = raw as OkxUpdate
  const channel = upd.arg?.channel ?? 'unknown'
  const data = upd.data ?? []

  if (channel === 'orders') {
    const orders: OrderEvent[] = []
    for (const item of data) {
      const d = item as OkxOrderData
      const order: Order = {
        exchange,
        symbol: d.instId,
        clientOrderId: d.clOrdId ?? '',
        exchangeOrderId: d.ordId,
        side: mapOkxSide(d.side),
        type: d.ordType === 'limit' ? 'limit' : 'market',
        qty: parseFloat(d.sz),
        filledQty: parseFloat(d.fillSz ?? '0'),
        reduceOnly: d.reduceOnly === true,
        status: mapOkxOrderStatus(d.state),
        submittedAt: d.cTime ? parseInt(d.cTime, 10) : receivedAt,
        updatedAt: d.uTime ? parseInt(d.uTime, 10) : receivedAt,
      }
      const px = parseFloat(d.px ?? '0')
      if (px > 0) order.price = px
      const avgPx = parseFloat(d.avgPx ?? '0')
      if (avgPx > 0) order.avgFillPrice = avgPx
      orders.push({ exchange, order, seq, receivedAt })
    }
    return { orders, eventType: 'orders' }
  }

  if (channel === 'positions') {
    const positions: PositionEvent[] = []
    for (const item of data) {
      const d = item as OkxPositionData
      const qty = Math.abs(parseFloat(d.pos))
      const position: Position = {
        exchange,
        symbol: d.instId,
        qty,
        side: d.posSide === 'short' ? 'short' : d.posSide === 'long' ? 'long' : 'flat',
        leverage: parseFloat(d.lever ?? '1'),
        updatedAt: d.uTime ? parseInt(d.uTime, 10) : receivedAt,
      }
      const avgPx = parseFloat(d.avgPx ?? '0')
      if (avgPx > 0) position.entryPrice = avgPx
      const upl = parseFloat(d.upl ?? 'NaN')
      if (!isNaN(upl)) position.unrealizedPnl = upl
      const liqPx = parseFloat(d.liqPx ?? '0')
      if (liqPx > 0) position.liquidationPrice = liqPx
      positions.push({ exchange, position, seq, receivedAt })
    }
    return { positions, eventType: 'positions' }
  }

  if (channel === 'account') {
    const balances: BalanceEvent[] = []
    const fundingFees: FundingFeeEvent[] = []
    for (const item of data) {
      const d = item as OkxAccountData
      for (const detail of d.details ?? []) {
        const available = parseFloat(detail.availBal ?? '0')
        const locked = parseFloat(detail.frozenBal ?? '0')
        const balance: Balance = {
          exchange,
          asset: detail.ccy,
          available,
          locked,
          updatedAt: receivedAt,
        }
        balances.push({ exchange, balance, seq, receivedAt })
      }
      // OKX posts funding-fee notifications via account channel bills array
      for (const bill of d.bills ?? []) {
        if (!bill.bizType?.toUpperCase().includes('FUND')) continue
        if (!bill.instId) continue
        const fundingTime = bill.ts ? parseInt(bill.ts, 10) : receivedAt
        const fundingAmount = bill.pnl ? parseFloat(bill.pnl) : 0
        const positionQty = bill.sz ? Math.abs(parseFloat(bill.sz)) : 0
        fundingFees.push({
          exchange,
          symbol: bill.instId,
          fundingTime,
          fundingRate: 0,
          fundingAmount,
          asset: bill.ccy ?? 'USDT',
          positionQty,
          receivedAt,
        })
      }
    }
    if (fundingFees.length > 0) return { balances, fundingFees, eventType: 'account' }
    return { balances, eventType: 'account' }
  }

  return { eventType: channel }
}
