import { ccxtIdMap } from '../../markets/ccxtIdMap.js'
import type { OrderRequest, OrderRef } from './types.js'
import { createCcxtRestAdapter, type CcxtAdapterSpec, type BaseRestAdapterOptions } from './ccxt-base.js'

const bitgetSpec: CcxtAdapterSpec = {
  exchange: 'bitget',
  ccxtId: ccxtIdMap.bitget,
  ccxtOptions: { defaultType: 'swap', productType: 'USDT-FUTURES' },
  duplicateOrderCodes: new Set(['40762']),
  buildCreateOrderParams: (req: OrderRequest) => {
    const p: Record<string, unknown> = {
      clientOid: req.clientOrderId,
      // Bitget USDT-FUTURES V2 API requires tradeSide in both one-way and hedge mode
      tradeSide: req.reduceOnly ? 'Close' : 'Open',
    }
    if (req.timeInForce) p.timeInForce = req.timeInForce
    if (req.stopPrice !== undefined) p.stopPrice = req.stopPrice
    return p
  },
  buildCancelOrderParams: (ref: OrderRef) => {
    const p: Record<string, unknown> = {}
    if (ref.clientOrderId) p.clientOid = ref.clientOrderId
    return p
  },
  buildFetchOrderParams: (ref: OrderRef) => ({
    clientOid: ref.clientOrderId ?? '',
  }),
}

export type BitgetRestAdapterOptions = BaseRestAdapterOptions

export function createBitgetRestAdapter(
  opts: BitgetRestAdapterOptions
): ReturnType<typeof createCcxtRestAdapter> {
  return createCcxtRestAdapter(bitgetSpec, opts)
}
