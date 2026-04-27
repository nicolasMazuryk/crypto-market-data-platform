import { ccxtIdMap } from '../../markets/ccxtIdMap.js'
import type { OrderRequest, OrderRef } from './types.js'
import { createCcxtRestAdapter, type CcxtAdapterSpec, type BaseRestAdapterOptions } from './ccxt-base.js'

const kucoinSpec: CcxtAdapterSpec = {
  exchange: 'kucoin',
  ccxtId: ccxtIdMap.kucoin,
  ccxtOptions: { defaultType: 'swap' },
  // KuCoin Futures rejects duplicate clientOid (verify exact code on live smoke run)
  duplicateOrderCodes: new Set(['ORDER_ALREADY_EXISTS']),
  // 100004 = "The order cannot be canceled" (already filled/cancelled)
  cancelIgnoreCodes: new Set(['100004']),
  setLeverage: async (ccxtEx, unified, leverage) => {
    // CCXT kucoinfutures setLeverage requires marginMode='cross' in params
    if (!ccxtEx.setLeverage) return
    await ccxtEx.setLeverage(leverage, unified, { marginMode: 'cross' })
  },
  buildCreateOrderParams: (req: OrderRequest) => {
    const p: Record<string, unknown> = {
      clientOid: req.clientOrderId,
      // KuCoin Futures requires marginMode to match the account's configured mode
      marginMode: 'cross',
    }
    if (req.reduceOnly) p.reduceOnly = true
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

export type KucoinRestAdapterOptions = BaseRestAdapterOptions

export function createKucoinRestAdapter(
  opts: KucoinRestAdapterOptions
): ReturnType<typeof createCcxtRestAdapter> {
  return createCcxtRestAdapter(kucoinSpec, opts)
}
