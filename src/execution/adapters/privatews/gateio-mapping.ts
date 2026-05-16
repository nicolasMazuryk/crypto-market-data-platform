import type { Exchange } from '../../types/exchange.js'
import type { OrderStatus, Position, Balance, Order } from '../rest/types.js'
import type { OrderEvent, PositionEvent, BalanceEvent, FundingFeeEvent, FillEvent } from './types.js'
import type { ParsedWsMessage } from './private-ws-base.js'
import { normalizeSymbol } from '../../../utils/symbol-normalizer.js'

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

interface GateioAccountBookEntry {
  contract?: string
  change?: string
  change_type?: string
  time?: number
  currency?: string
  funding_rate?: number
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

/**
 * Creates a stateful GateIO message parser that synthesizes fill events from
 * order updates by tracking per-order filledQty advancement. GateIO's
 * futures.orders channel delivers cumulative filledQty per update; fill events
 * are synthesized when filledQty increases. Fee fields are left null since
 * per-trade fees are not available on this channel.
 */
export function createGateioMessageParser(
  exchange: Exchange = 'gateio'
): (raw: unknown, receivedAt: number, seq: number) => ParsedWsMessage {
  const prevFilledQtyByOrder = new Map<string, number>()

  return function parseGateioMessageStateful(
    raw: unknown,
    receivedAt: number,
    seq: number
  ): ParsedWsMessage {
    const upd = raw as GateioUpdate
    const channel = upd.channel ?? 'unknown'
    const result = upd.result

    if (process.env.GATEIO_ACCTBOOK_DEBUG === '1') {
      process.stdout.write(JSON.stringify({ _debug: 'gateio.channel', channel, event: upd.event }) + '\n')
    }

    if (channel === 'futures.orders') {
      const items = Array.isArray(result) ? result : result !== undefined ? [result] : []
      const orders: OrderEvent[] = []
      const fills: FillEvent[] = []
      for (const item of items) {
        const d = item as GateioOrderData
        const absSize = Math.abs(d.size)
        const side = d.size >= 0 ? 'buy' : ('sell' as const)
        const filledQty = absSize - Math.abs(d.left ?? d.size)
        const updatedAt = d.update_time
          ? d.update_time > 1e10
            ? Math.floor(d.update_time)
            : Math.floor(d.update_time * 1000)
          : receivedAt
        const order: Order = {
          exchange,
          symbol: d.contract,
          clientOrderId: d.text ? stripGateioTextPrefix(d.text) : '',
          exchangeOrderId: String(d.id),
          side,
          type: !d.price || parseFloat(d.price) === 0 ? 'market' : 'limit',
          qty: absSize,
          filledQty,
          reduceOnly: d.is_reduce_only ?? false,
          status: mapGateioOrderStatus(d),
          submittedAt: d.create_time
            ? d.create_time > 1e10
              ? Math.floor(d.create_time)
              : Math.floor(d.create_time * 1000)
            : receivedAt,
          updatedAt,
        }
        const px = parseFloat(d.price ?? '0')
        if (px > 0) order.price = px
        const fillPx = parseFloat(d.fill_price ?? '0')
        if (fillPx > 0) order.avgFillPrice = fillPx
        orders.push({ exchange, order, seq, receivedAt })

        const orderId = String(d.id)
        const prevFilled = prevFilledQtyByOrder.get(orderId) ?? 0
        if (filledQty > prevFilled) {
          const delta = filledQty - prevFilled
          // Synthetic fill ID: deterministic from orderId + updatedAt + cumulative filledQty
          fills.push({
            exchange,
            symbol: d.contract,
            clientOrderId: d.text ? stripGateioTextPrefix(d.text) : '',
            exchangeOrderId: orderId,
            exchangeFillId: `${exchange}:${orderId}:${updatedAt}:${filledQty}`,
            qty: delta,
            price: fillPx > 0 ? fillPx : 0,
            feeAsset: 'USDT',
            feeAmount: 0,
            isMaker: false,
            ts: updatedAt,
            receivedAt,
          })
        }
        prevFilledQtyByOrder.set(orderId, filledQty)
      }
      return { orders, ...(fills.length > 0 ? { fills } : {}), eventType: 'futures.orders' }
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

    if (channel === 'futures.account_book') {
      const fundingFees: FundingFeeEvent[] = []
      const items = Array.isArray(result) ? result : result !== undefined ? [result] : []
      for (const item of items) {
        const d = item as GateioAccountBookEntry
        if (process.env.GATEIO_ACCTBOOK_DEBUG === '1') {
          process.stdout.write(JSON.stringify({ _debug: 'gateio.account_book', change_type: d.change_type, contract: d.contract, change: d.change, time: d.time }) + '\n')
        }
        if (d.change_type !== 'fund') continue
        if (!d.contract) continue
        const fundingAmount = d.change ? parseFloat(d.change) : 0
        const fundingTime = d.time ? Math.floor(d.time * 1000) : receivedAt
        fundingFees.push({
          exchange,
          symbol: normalizeSymbol(d.contract),
          fundingTime,
          fundingRate: d.funding_rate ?? 0,
          fundingAmount,
          asset: d.currency ?? 'USDT',
          positionQty: 0,
          receivedAt,
        })
      }
      if (fundingFees.length > 0) return { fundingFees, eventType: 'futures.account_book' }
      return { eventType: 'futures.account_book' }
    }

    return { eventType: channel }
  }
}

/** Stateless parser kept for backward-compatibility in tests; does not synthesize fills. */
export function parseGateioMessage(
  raw: unknown,
  receivedAt: number,
  seq: number,
  exchange: Exchange = 'gateio'
): ParsedWsMessage {
  return createGateioMessageParser(exchange)(raw, receivedAt, seq)
}
