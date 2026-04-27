import { ccxtIdMap } from '../../markets/ccxtIdMap.js'
import type { OrderRequest, OrderRef } from './types.js'
import { createCcxtRestAdapter, type CcxtAdapterSpec, type BaseRestAdapterOptions } from './ccxt-base.js'

const gateioSpec: CcxtAdapterSpec = {
  exchange: 'gateio',
  ccxtId: ccxtIdMap.gateio,
  ccxtOptions: { defaultType: 'swap' },
  // Gate.io rejects duplicate text fields with TEXT_DUPLICATED (verify on live smoke run)
  duplicateOrderCodes: new Set(['TEXT_DUPLICATED']),
  setLeverage: async (ccxtEx, unified, leverage) => {
    if (!ccxtEx.setLeverage) return
    try {
      await ccxtEx.setLeverage(leverage, unified)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // CCXT throws "not support this market type" for Gate.io perps; leverage is
      // set per-position via the order request instead — safe to skip here.
      if (msg.includes('not support this market type') || msg.includes('NotSupported')) return
      throw err
    }
  },
  buildCreateOrderParams: (req: OrderRequest) => {
    const p: Record<string, unknown> = { text: req.clientOrderId }
    if (req.leverage !== undefined) p.leverage = req.leverage
    if (req.reduceOnly) p.reduce_only = true
    if (req.timeInForce) p.tif = req.timeInForce
    if (req.stopPrice !== undefined) p.stopPrice = req.stopPrice
    return p
  },
  buildCancelOrderParams: (ref: OrderRef) => {
    const p: Record<string, unknown> = {}
    if (ref.clientOrderId) p.text = ref.clientOrderId
    return p
  },
  buildFetchOrderParams: (ref: OrderRef) => ({
    text: ref.clientOrderId ?? '',
  }),
}

export type GateioRestAdapterOptions = BaseRestAdapterOptions

export function createGateioRestAdapter(
  opts: GateioRestAdapterOptions
): ReturnType<typeof createCcxtRestAdapter> {
  return createCcxtRestAdapter(gateioSpec, opts)
}
