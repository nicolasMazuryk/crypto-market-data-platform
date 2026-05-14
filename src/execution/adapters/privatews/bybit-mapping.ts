import type { Exchange } from '../../types/exchange.js'
import type { OrderSide, OrderStatus, Position, Balance, Order } from '../rest/types.js'
import type { OrderEvent, PositionEvent, BalanceEvent, FundingFeeEvent } from './types.js'
import type { ParsedWsMessage } from './private-ws-base.js'

interface BybitOrderData {
  orderId: string
  orderLinkId?: string
  symbol: string
  side: string
  orderType: string
  qty: string
  price?: string
  avgPrice?: string
  orderStatus: string
  cumExecQty?: string
  reduceOnly?: boolean
  createdTime?: string
  updatedTime?: string
  stopOrderType?: string
  triggerPrice?: string
}

interface BybitPositionData {
  symbol: string
  side: string
  size: string
  avgPrice?: string
  unrealisedPnl?: string
  leverage?: string
  liqPrice?: string
  updatedTime?: string
}

interface BybitWalletCoin {
  coin: string
  availableToWithdraw?: string
  totalOrderIM?: string
  walletBalance?: string
}

interface BybitWalletData {
  coin?: BybitWalletCoin[]
}

interface BybitExecutionData {
  symbol: string
  execType: string
  execFee?: string
  execTime?: string
  execQty?: string
  feeRate?: string
  feeCurrency?: string
}

interface BybitUpdate {
  topic?: string
  data?: unknown
}

function mapBybitOrderStatus(s: string): OrderStatus {
  switch (s) {
    case 'New':
      return 'new'
    case 'PartiallyFilled':
      return 'partially_filled'
    case 'Filled':
      return 'filled'
    case 'Cancelled':
      return 'cancelled'
    case 'Rejected':
      return 'rejected'
    default:
      return 'new'
  }
}

export function parseBybitMessage(
  raw: unknown,
  receivedAt: number,
  seq: number,
  exchange: Exchange = 'bybit'
): ParsedWsMessage {
  const upd = raw as BybitUpdate
  const topic = upd.topic ?? 'unknown'
  const data = upd.data

  if (topic === 'order') {
    const orders: OrderEvent[] = []
    const items = Array.isArray(data) ? data : [data]
    for (const item of items) {
      const d = item as BybitOrderData
      const order: Order = {
        exchange,
        symbol: d.symbol,
        clientOrderId: d.orderLinkId ?? '',
        exchangeOrderId: d.orderId,
        side: d.side.toLowerCase() === 'sell' ? 'sell' : ('buy' as OrderSide),
        type: d.orderType === 'Limit' ? 'limit' : d.stopOrderType ? 'stop_market' : 'market',
        qty: parseFloat(d.qty),
        filledQty: parseFloat(d.cumExecQty ?? '0'),
        reduceOnly: d.reduceOnly ?? false,
        status: mapBybitOrderStatus(d.orderStatus),
        submittedAt: d.createdTime ? (v => v > 9_999_999_999_999 ? Math.floor(v / 1000) : v)(parseInt(d.createdTime, 10)) : receivedAt,
        updatedAt: d.updatedTime ? (v => v > 9_999_999_999_999 ? Math.floor(v / 1000) : v)(parseInt(d.updatedTime, 10)) : receivedAt,
      }
      const px = parseFloat(d.price ?? '0')
      if (px > 0) order.price = px
      const avgPx = parseFloat(d.avgPrice ?? '0')
      if (avgPx > 0) order.avgFillPrice = avgPx
      const trigPx = parseFloat(d.triggerPrice ?? '0')
      if (trigPx > 0) order.stopPrice = trigPx
      orders.push({ exchange, order, seq, receivedAt })
    }
    return { orders, eventType: topic }
  }

  if (topic === 'position') {
    const positions: PositionEvent[] = []
    const items = Array.isArray(data) ? data : [data]
    for (const item of items) {
      const d = item as BybitPositionData
      const qty = Math.abs(parseFloat(d.size))
      const position: Position = {
        exchange,
        symbol: d.symbol,
        qty,
        side: d.side === 'Sell' ? 'short' : d.side === 'Buy' ? 'long' : 'flat',
        leverage: parseFloat(d.leverage ?? '1'),
        updatedAt: d.updatedTime ? parseInt(d.updatedTime, 10) : receivedAt,
      }
      const avgPx = parseFloat(d.avgPrice ?? '0')
      if (avgPx > 0) position.entryPrice = avgPx
      const upl = parseFloat(d.unrealisedPnl ?? 'NaN')
      if (!isNaN(upl)) position.unrealizedPnl = upl
      const liqPx = parseFloat(d.liqPrice ?? '0')
      if (liqPx > 0) position.liquidationPrice = liqPx
      positions.push({ exchange, position, seq, receivedAt })
    }
    return { positions, eventType: topic }
  }

  if (topic === 'execution') {
    const fundingFees: FundingFeeEvent[] = []
    const items = Array.isArray(data) ? data : [data]
    for (const item of items) {
      const d = item as BybitExecutionData
      if (process.env.BYBIT_EXEC_DEBUG === '1') {
        process.stdout.write(JSON.stringify({ _debug: 'bybit.execution', symbol: d.symbol, execType: d.execType, execTime: d.execTime, execFee: d.execFee }) + '\n')
      }
      if (d.execType !== 'Funding') continue
      const fundingTime = d.execTime ? parseInt(d.execTime, 10) : receivedAt
      const fundingRate = d.feeRate ? parseFloat(d.feeRate) : 0
      const fundingAmount = d.execFee ? parseFloat(d.execFee) : 0
      const positionQty = d.execQty ? Math.abs(parseFloat(d.execQty)) : 0
      fundingFees.push({
        exchange,
        symbol: d.symbol,
        fundingTime,
        fundingRate,
        fundingAmount,
        asset: d.feeCurrency ?? 'USDT',
        positionQty,
        receivedAt,
      })
    }
    if (fundingFees.length > 0) return { fundingFees, eventType: 'execution.funding' }
    return { eventType: 'execution' }
  }

  if (topic === 'wallet') {
    if (process.env.BYBIT_EXEC_DEBUG === '1') {
      process.stdout.write(JSON.stringify({ _debug: 'bybit.wallet', data }) + '\n')
    }
    const balances: BalanceEvent[] = []
    const items = Array.isArray(data) ? data : [data]
    for (const item of items) {
      const d = item as BybitWalletData
      for (const coin of d.coin ?? []) {
        const available = parseFloat(coin.availableToWithdraw ?? '0')
        const walletBal = parseFloat(coin.walletBalance ?? '0')
        const locked = Math.max(0, walletBal - available)
        const balance: Balance = {
          exchange,
          asset: coin.coin,
          available,
          locked,
          updatedAt: receivedAt,
        }
        balances.push({ exchange, balance, seq, receivedAt })
      }
    }
    return { balances, eventType: topic }
  }

  return { eventType: topic }
}
