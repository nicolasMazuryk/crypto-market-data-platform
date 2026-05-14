import { ccxtIdMap } from '../../markets/ccxtIdMap.js'
import type { CcxtExchange, CcxtOrder } from '../../../exchanges/types.js'
import type { OrderRequest, OrderRef } from './types.js'
import { createCcxtRestAdapter, type CcxtAdapterSpec, type BaseRestAdapterOptions } from './ccxt-base.js'

const bybitSpec: CcxtAdapterSpec = {
  exchange: 'bybit',
  ccxtId: ccxtIdMap.bybit,
  ccxtOptions: { defaultType: 'swap' },
  duplicateOrderCodes: new Set(['110071']),
  setLeverage: async (ccxtEx, unified, leverage) => {
    if (!ccxtEx.setLeverage) return
    try {
      await ccxtEx.setLeverage(leverage, unified)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // 110043 = leverage not modified (already at target); 110077 = pm mode cannot set leverage
      if (msg.includes('110043') || msg.includes('110077')) return
      throw err
    }
  },
  setPositionMode: async (ccxtEx, hedged, unified) => {
    if (!ccxtEx.setPositionMode || !unified) return
    try {
      await ccxtEx.setPositionMode(hedged, unified, { category: 'linear' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('position mode not modified') || msg.includes('110026') || msg.includes('110077')) return
      throw err
    }
  },
  setMarginMode: async (ccxtEx, unified, mode) => {
    if (!ccxtEx.setMarginMode) return
    try {
      await ccxtEx.setMarginMode(mode, unified, { category: 'linear' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not modified') || msg.includes('110026') || msg.includes('110077')) return
      throw err
    }
  },
  // Bybit V5 orderType only accepts 'Market' or 'Limit'. Trigger behaviour
  // is controlled via triggerPrice/triggerDirection in params, not the type string.
  mapCcxtOrderType: (req: OrderRequest): string => (req.type === 'stop_market' ? 'market' : req.type),
  buildCreateOrderParams: (req: OrderRequest) => {
    const p: Record<string, unknown> = { orderLinkId: req.clientOrderId }
    if (req.reduceOnly) p.reduceOnly = true
    if (req.timeInForce) p.timeInForce = req.timeInForce
    if (req.stopPrice !== undefined) {
      p.stopPrice = req.stopPrice
      // Bybit V5 triggerDirection: 1 = rises to trigger (close short),
      // 2 = falls to trigger (close long). Required for all conditional orders.
      p.triggerDirection = req.side === 'sell' ? 2 : 1
    }
    return p
  },
  buildCancelOrderParams: (ref: OrderRef) => {
    const p: Record<string, unknown> = {}
    if (ref.clientOrderId) p.orderLinkId = ref.clientOrderId
    return p
  },
  buildFetchOrderParams: (ref: OrderRef) => ({
    orderLinkId: ref.clientOrderId ?? '',
  }),
  // Bybit's fetchOrder (even with acknowledged:true) only queries /v5/order/realtime (open orders).
  // For filled/cancelled orders we must fall back to /v5/order/history via fetchClosedOrders.
  getOrder: async (ccxtEx: CcxtExchange, ref: OrderRef, unified: string): Promise<CcxtOrder | undefined> => {
    const clientOrderId = ref.clientOrderId ?? ''
    if (!clientOrderId) return undefined
    const linkParam = { orderLinkId: clientOrderId }

    // 1. Check open (realtime) orders — fastest path when SL/TP is still pending
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const opens = await ccxtEx.fetchOpenOrders!(unified, undefined, undefined, linkParam)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (opens.length > 0) return opens[0]!

    // 2. Not open — check order history for filled/cancelled orders
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const history = await ccxtEx.fetchClosedOrders!(unified, undefined, undefined, linkParam)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return history.length > 0 ? history[0]! : undefined
  },
}

export type BybitRestAdapterOptions = BaseRestAdapterOptions

export function createBybitRestAdapter(opts: BybitRestAdapterOptions): ReturnType<typeof createCcxtRestAdapter> {
  return createCcxtRestAdapter(bybitSpec, opts)
}
