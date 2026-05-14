import { ccxtIdMap } from '../../markets/ccxtIdMap.js'
import type { OrderRequest, OrderRef } from './types.js'
import { createCcxtRestAdapter, type CcxtAdapterSpec, type BaseRestAdapterOptions } from './ccxt-base.js'

const okxSpec: CcxtAdapterSpec = {
  exchange: 'okx',
  ccxtId: ccxtIdMap.okx,
  ccxtOptions: { defaultType: 'swap' },
  duplicateOrderCodes: new Set(['51016']),
  canonicalizeClientOrderId: (id: string) => id.replace(/-/g, '').slice(0, 32),
  setPositionMode: async (ccxtEx, hedged) => {
    if (!ccxtEx.setPositionMode) return
    await ccxtEx.setPositionMode(hedged)
  },
  // In OKX net_mode (one-way), cross margin is the account default.
  // setMarginMode requires a lever param that varies per-strategy and is unnecessary here.
  setMarginMode: async () => {
    /* no-op */
  },
  buildCreateOrderParams: (req: OrderRequest) => {
    const p: Record<string, unknown> = {
      // OKX clOrdId: alphanumeric only, max 32 chars (no dashes or underscores)
      clOrdId: req.clientOrderId.replace(/-/g, '').slice(0, 32),
    }
    if (req.reduceOnly) p.reduceOnly = true
    if (req.timeInForce) p.timeInForce = req.timeInForce
    if (req.stopPrice !== undefined) p.stopPrice = req.stopPrice
    return p
  },
  buildCancelOrderParams: (ref: OrderRef) => {
    const p: Record<string, unknown> = {}
    if (ref.clientOrderId) p.clOrdId = ref.clientOrderId.replace(/-/g, '').slice(0, 32)
    return p
  },
  buildFetchOrderParams: (ref: OrderRef) => ({
    clOrdId: (ref.clientOrderId ?? '').replace(/-/g, '').slice(0, 32),
  }),
}

export type OkxRestAdapterOptions = BaseRestAdapterOptions

export function createOkxRestAdapter(opts: OkxRestAdapterOptions): ReturnType<typeof createCcxtRestAdapter> {
  return createCcxtRestAdapter(okxSpec, opts)
}
