import type { Exchange } from '../../types/exchange.js'
import type { OrderSide, OrderStatus, Position, Balance, Order } from '../rest/types.js'
import type { OrderEvent, PositionEvent, BalanceEvent } from './types.js'
import type { ParsedWsMessage } from './private-ws-base.js'

interface BitgetOrderData {
  orderId: string
  clientOid?: string
  instId: string
  side: string
  orderType: string
  size: string
  price?: string
  avgPx?: string
  status: string
  accBaseVolume?: string
  reduceOnly?: boolean | string
  cTime?: string
  uTime?: string
}

interface BitgetPositionData {
  instId: string
  posSide: string
  pos: string
  avgPx?: string
  upl?: string
  lever?: string
  liqPx?: string
  uTime?: string
}

interface BitgetBalanceData {
  coinName: string
  available: string
  frozen: string
  uTime?: string
}

interface BitgetUpdate {
  action?: string
  arg?: { channel: string; instType?: string }
  data?: unknown[]
}

function mapBitgetOrderStatus(state: string): OrderStatus {
  switch (state.toLowerCase()) {
    case 'new':
    case 'live':
      return 'new'
    case 'partially_filled':
    case 'partially-fill':
      return 'partially_filled'
    case 'filled':
    case 'full_fill':
      return 'filled'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    case 'rejected':
      return 'rejected'
    default:
      return 'new'
  }
}

function mapBitgetSide(side: string): OrderSide {
  return side.toLowerCase() === 'sell' ? 'sell' : 'buy'
}

export function parseBitgetMessage(
  raw: unknown,
  receivedAt: number,
  seq: number,
  exchange: Exchange = 'bitget'
): ParsedWsMessage {
  const upd = raw as BitgetUpdate
  const channel = upd.arg?.channel ?? 'unknown'
  const data = upd.data ?? []

  if (channel === 'orders') {
    const orders: OrderEvent[] = []
    for (const item of data) {
      const d = item as BitgetOrderData
      const order: Order = {
        exchange,
        symbol: d.instId,
        clientOrderId: d.clientOid ?? '',
        exchangeOrderId: d.orderId,
        side: mapBitgetSide(d.side),
        type: d.orderType === 'limit' ? 'limit' : 'market',
        qty: parseFloat(d.size),
        filledQty: parseFloat(d.accBaseVolume ?? '0'),
        reduceOnly: d.reduceOnly === true || d.reduceOnly === 'yes',
        status: mapBitgetOrderStatus(d.status),
        submittedAt: d.cTime ? parseInt(d.cTime, 10) : receivedAt,
        updatedAt: d.uTime ? parseInt(d.uTime, 10) : receivedAt,
      }
      const px = parseFloat(d.price ?? '0')
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
      const d = item as BitgetPositionData
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
    for (const item of data) {
      const d = item as BitgetBalanceData
      const available = parseFloat(d.available)
      const locked = parseFloat(d.frozen)
      const balance: Balance = {
        exchange,
        asset: d.coinName,
        available,
        locked,
        updatedAt: d.uTime ? parseInt(d.uTime, 10) : receivedAt,
      }
      balances.push({ exchange, balance, seq, receivedAt })
    }
    return { balances, eventType: 'account' }
  }

  return { eventType: channel }
}
