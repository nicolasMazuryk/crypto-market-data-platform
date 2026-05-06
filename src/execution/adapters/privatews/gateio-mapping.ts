import type { Exchange } from '../../types/exchange.js'
import type { OrderStatus, Position, Balance, Order } from '../rest/types.js'
import type { OrderEvent, PositionEvent, BalanceEvent } from './types.js'
import type { ParsedWsMessage } from './private-ws-base.js'

interface GateioOrderData {
  id: string | number
  text?: string
  contract: string
  size: number
  price?: string
  fill_price?: string
  left?: number
  status: string
  finish_as?: string
  is_reduce_only?: boolean
  create_time?: number
  finish_time?: number
  update_time?: number
}

interface GateioPositionData {
  contract: string
  size: number
  leverage?: string
  entry_price?: string
  unrealised_pnl?: string
  liq_price?: string
  update_time?: number
}

interface GateioBalanceData {
  currency: string
  balance?: string
  available?: string
  order_margin?: string
}

interface GateioUpdate {
  channel?: string
  event?: string
  result?: unknown
}

function mapGateioOrderStatus(data: GateioOrderData): OrderStatus {
  if (data.status === 'finished') {
    const finishAs = data.finish_as ?? ''
    if (
      finishAs === 'cancelled' ||
      finishAs === 'ioc' ||
      finishAs === 'reduce_only' ||
      finishAs === 'position_closed'
    ) {
      return 'cancelled'
    }
    return 'filled'
  }
  if (data.status === 'open') {
    const originalSize = Math.abs(data.size)
    const remaining = Math.abs(data.left ?? data.size)
    if (originalSize > 0 && remaining < originalSize) return 'partially_filled'
    return 'new'
  }
  return 'new'
}

function stripGateioTextPrefix(text: string): string {
  return text.startsWith('t-') ? text.slice(2) : text
}

export function parseGateioMessage(
  raw: unknown,
  receivedAt: number,
  seq: number,
  exchange: Exchange = 'gateio'
): ParsedWsMessage {
  const upd = raw as GateioUpdate
  const channel = upd.channel ?? 'unknown'
  const result = upd.result

  if (channel === 'futures.orders') {
    const items = Array.isArray(result) ? result : result !== undefined ? [result] : []
    const orders: OrderEvent[] = []
    for (const item of items) {
      const d = item as GateioOrderData
      const absSize = Math.abs(d.size)
      const side = d.size >= 0 ? 'buy' : ('sell' as const)
      const order: Order = {
        exchange,
        symbol: d.contract,
        clientOrderId: d.text ? stripGateioTextPrefix(d.text) : '',
        exchangeOrderId: String(d.id),
        side,
        type: !d.price || parseFloat(d.price) === 0 ? 'market' : 'limit',
        qty: absSize,
        filledQty: absSize - Math.abs(d.left ?? d.size),
        reduceOnly: d.is_reduce_only ?? false,
        status: mapGateioOrderStatus(d),
        submittedAt: d.create_time ? Math.floor(d.create_time * 1000) : receivedAt,
        updatedAt: d.update_time ? Math.floor(d.update_time * 1000) : receivedAt,
      }
      const px = parseFloat(d.price ?? '0')
      if (px > 0) order.price = px
      const fillPx = parseFloat(d.fill_price ?? '0')
      if (fillPx > 0) order.avgFillPrice = fillPx
      orders.push({ exchange, order, seq, receivedAt })
    }
    return { orders, eventType: 'futures.orders' }
  }

  if (channel === 'futures.positions') {
    const items = Array.isArray(result) ? result : result !== undefined ? [result] : []
    const positions: PositionEvent[] = []
    for (const item of items) {
      const d = item as GateioPositionData
      const qty = Math.abs(d.size)
      const position: Position = {
        exchange,
        symbol: d.contract,
        qty,
        side: d.size > 0 ? 'long' : d.size < 0 ? 'short' : 'flat',
        leverage: parseFloat(d.leverage ?? '1'),
        updatedAt: d.update_time ? Math.floor(d.update_time * 1000) : receivedAt,
      }
      const entryPx = parseFloat(d.entry_price ?? '0')
      if (entryPx > 0) position.entryPrice = entryPx
      const upl = parseFloat(d.unrealised_pnl ?? 'NaN')
      if (!isNaN(upl)) position.unrealizedPnl = upl
      const liqPx = parseFloat(d.liq_price ?? '0')
      if (liqPx > 0) position.liquidationPrice = liqPx
      positions.push({ exchange, position, seq, receivedAt })
    }
    return { positions, eventType: 'futures.positions' }
  }

  if (channel === 'futures.balances') {
    const items = Array.isArray(result) ? result : result !== undefined ? [result] : []
    const balances: BalanceEvent[] = []
    for (const item of items) {
      const d = item as GateioBalanceData
      const available = parseFloat(d.available ?? '0')
      const locked = parseFloat(d.order_margin ?? '0')
      const total = parseFloat(d.balance ?? 'NaN')
      const balance: Balance = {
        exchange,
        asset: d.currency,
        available,
        locked,
        ...(!isNaN(total) ? { walletBalance: total } : {}),
        updatedAt: receivedAt,
      }
      balances.push({ exchange, balance, seq, receivedAt })
    }
    return { balances, eventType: 'futures.balances' }
  }

  return { eventType: channel }
}
