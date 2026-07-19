import type { Exchange } from '../../types/exchange.js'
import type { OrderStatus, Position, Balance, Order } from '../rest/types.js'
import type { OrderEvent, PositionEvent, BalanceEvent, FundingFeeEvent } from './types.js'
import type { ParsedWsMessage } from './private-ws-base.js'

interface KucoinOrderData {
  orderId: string
  clientOid?: string
  symbol: string
  side: string
  orderType: string
  price?: string
  size?: number
  filledSize?: number
  status: string
  type?: string
  reduceOnly?: boolean
  createdAt?: number
  ts?: number | string
}

interface KucoinPositionData {
  symbol: string
  currentQty?: number
  avgEntryPrice?: number
  unrealisedPnl?: number
  liquidationPrice?: number
  realLeverage?: number
  markValue?: number
  settleCurrency?: string
  changeReason?: string
}

interface KucoinWalletData {
  currency: string
  availableBalance?: number | string
  holdBalance?: number | string
  symbol?: string
  fundingFee?: number | string
  fundingRate?: number | string
  timestamp?: number
}

interface KucoinWsMessage {
  topic?: string
  subject?: string
  data?: unknown
}

function mapKucoinOrderStatus(status: string, type?: string): OrderStatus {
  switch (status) {
    case 'open':
      return type === 'match' ? 'partially_filled' : 'new'
    case 'done':
      return 'filled'
    case 'cancel':
      return 'cancelled'
    default:
      return 'new'
  }
}

export function parseKucoinMessage(
  raw: unknown,
  receivedAt: number,
  seq: number,
  exchange: Exchange = 'kucoin'
): ParsedWsMessage {
  const msg = raw as KucoinWsMessage
  const topic = msg.topic ?? 'unknown'
  const subject = msg.subject ?? ''
  const data = msg.data

  if (topic.startsWith('/contractMarket/tradeOrders') && subject === 'orderChange') {
    const d = data as KucoinOrderData
    const tsMs =
      d.ts !== undefined
        ? typeof d.ts === 'string'
          ? Number(BigInt(d.ts) / 1_000_000n)
          : Math.floor(d.ts / 1_000_000)
        : (d.createdAt ?? receivedAt)
    const order: Order = {
      exchange,
      symbol: d.symbol,
      clientOrderId: d.clientOid ?? '',
      exchangeOrderId: d.orderId,
      side: d.side === 'sell' ? 'sell' : 'buy',
      type: d.orderType === 'limit' ? 'limit' : 'market',
      qty: d.size ?? 0,
      filledQty: d.filledSize ?? 0,
      reduceOnly: d.reduceOnly ?? false,
      status: mapKucoinOrderStatus(d.status, d.type),
      submittedAt: d.createdAt ?? receivedAt,
      updatedAt: tsMs,
    }
    const px = parseFloat(d.price ?? '0')
    if (px > 0) order.price = px
    const orders: OrderEvent[] = [{ exchange, order, seq, receivedAt }]
    return { orders, eventType: 'tradeOrders', eventTimestampMs: tsMs }
  }

  if (topic.startsWith('/contract/position') && subject === 'position.change') {
    const d = data as KucoinPositionData
    const qty = Math.abs(d.currentQty ?? 0)
    const position: Position = {
      exchange,
      symbol: d.symbol,
      qty,
      side: (d.currentQty ?? 0) > 0 ? 'long' : (d.currentQty ?? 0) < 0 ? 'short' : 'flat',
      leverage: d.realLeverage ?? 1,
      updatedAt: receivedAt,
    }
    if (d.avgEntryPrice !== undefined && d.avgEntryPrice > 0) position.entryPrice = d.avgEntryPrice
    if (d.unrealisedPnl !== undefined) position.unrealizedPnl = d.unrealisedPnl
    if (d.liquidationPrice !== undefined && d.liquidationPrice > 0) position.liquidationPrice = d.liquidationPrice
    const positions: PositionEvent[] = [{ exchange, position, seq, receivedAt }]
    return { positions, eventType: 'position.change' }
  }

  if (topic.startsWith('/contractAccount/wallet')) {
    const d = data as KucoinWalletData
    const available =
      typeof d.availableBalance === 'string' ? parseFloat(d.availableBalance) : (d.availableBalance ?? 0)
    const locked = typeof d.holdBalance === 'string' ? parseFloat(d.holdBalance) : (d.holdBalance ?? 0)
    const balance: Balance = {
      exchange,
      asset: d.currency,
      available,
      locked,
      updatedAt: receivedAt,
    }
    const balances: BalanceEvent[] = [{ exchange, balance, seq, receivedAt }]

    // KuCoin emits wallet.funding subject for funding-fee credits
    if (subject === 'wallet.funding' && d.symbol && d.fundingFee !== undefined) {
      const fundingAmount = typeof d.fundingFee === 'string' ? parseFloat(d.fundingFee) : d.fundingFee
      const fundingTime = d.timestamp ?? receivedAt
      const fundingFees: FundingFeeEvent[] = [
        {
          exchange,
          symbol: d.symbol,
          fundingTime,
          fundingRate:
            d.fundingRate !== undefined
              ? typeof d.fundingRate === 'string'
                ? parseFloat(d.fundingRate)
                : d.fundingRate
              : 0,
          fundingAmount,
          asset: d.currency,
          positionQty: 0,
          receivedAt,
        },
      ]
      return { balances, fundingFees, eventType: 'wallet.funding' }
    }

    return { balances, eventType: 'wallet' }
  }

  return { eventType: subject || topic }
}
