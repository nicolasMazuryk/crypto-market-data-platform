import { ccxtIdMap } from '../../markets/ccxtIdMap.js'
import type { OrderRequest, OrderRef } from './types.js'
import { createCcxtRestAdapter, type CcxtAdapterSpec, type BaseRestAdapterOptions } from './ccxt-base.js'

const binanceSpec: CcxtAdapterSpec = {
  exchange: 'binance',
  ccxtId: ccxtIdMap.binance,
  ccxtOptions: { defaultType: 'swap', adjustForTimeDifference: true, warnOnFetchOpenOrdersWithoutSymbol: false },
  duplicateOrderCodes: new Set(['-2010', '-4116']),
  leverageAlreadySetCode: '-4046',
  buildCreateOrderParams: (req: OrderRequest) => {
    const p: Record<string, unknown> = { newClientOrderId: req.clientOrderId }
    if (req.reduceOnly) p.reduceOnly = true
    if (req.timeInForce) p.timeInForce = req.timeInForce
    if (req.stopPrice !== undefined) p.stopPrice = req.stopPrice
    return p
  },
  buildCancelOrderParams: (ref: OrderRef) => {
    const p: Record<string, unknown> = {}
    if (ref.clientOrderId) p.origClientOrderId = ref.clientOrderId
    return p
  },
  buildFetchOrderParams: (ref: OrderRef) => ({
    origClientOrderId: ref.clientOrderId ?? '',
  }),
  buildAmendOrderParams: (ref: Required<Pick<OrderRef, 'symbol' | 'clientOrderId'>>) => ({
    origClientOrderId: ref.clientOrderId,
  }),
}

export type BinanceRestAdapterOptions = BaseRestAdapterOptions

export function createBinanceRestAdapter(opts: BinanceRestAdapterOptions): ReturnType<typeof createCcxtRestAdapter> {
  return createCcxtRestAdapter(binanceSpec, opts)
}
