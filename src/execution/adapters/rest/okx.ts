import { ccxtIdMap } from '../../markets/ccxtIdMap.js'
import { normalizeSymbol } from '../../../utils/symbol-normalizer.js'
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
    // OKX algo (stop) orders don't support reduceOnly — passing it causes 51205 rejection.
    if (req.reduceOnly && req.type !== 'stop_market') p.reduceOnly = true
    if (req.timeInForce) p.timeInForce = req.timeInForce
    if (req.stopPrice !== undefined) p.stopPrice = req.stopPrice
    if (req.type === 'stop_market') p.orderPx = '-1'
    return p
  },
  mapCcxtOrderType: (req: OrderRequest) => (req.type === 'stop_market' ? 'market' : req.type),
  buildCancelOrderParams: (ref: OrderRef) => {
    const p: Record<string, unknown> = {}
    if (ref.clientOrderId) p.clOrdId = ref.clientOrderId.replace(/-/g, '').slice(0, 32)
    return p
  },
  buildFetchOrderParams: (ref: OrderRef) => ({
    clOrdId: (ref.clientOrderId ?? '').replace(/-/g, '').slice(0, 32),
  }),
  buildExtras: ccxtEx => ({
    async fetchFundingFeeIncome(symbol: string, fundingTs: number) {
      if (!ccxtEx.fetchFundingHistory) return null
      await ccxtEx.loadMarkets()
      const wanted = normalizeSymbol(symbol)
      const market = Object.values(ccxtEx.markets).find(m => {
        return normalizeSymbol(m.symbol) === wanted || normalizeSymbol(m.id) === wanted
      })
      const unifiedSymbol = market?.symbol ?? symbol
      const since = fundingTs - 60_000
      const history = await ccxtEx.fetchFundingHistory(unifiedSymbol, since, 20, {
        type: '8',
        instType: 'SWAP',
      })
      const match = history.find(row => {
        const ts = typeof row.timestamp === 'number' ? row.timestamp : undefined
        const rowSymbol = typeof row.symbol === 'string' ? row.symbol : undefined
        if (ts === undefined || Math.abs(ts - fundingTs) > 60_000) return false
        return rowSymbol === undefined || normalizeSymbol(rowSymbol) === wanted
      })
      if (!match) return null
      const amount = typeof match.amount === 'number' ? match.amount : Number(match.amount)
      if (!Number.isFinite(amount)) return null
      const ts = typeof match.timestamp === 'number' ? match.timestamp : fundingTs
      const asset = typeof match.code === 'string' && match.code.length > 0 ? match.code : 'USDT'
      return {
        symbol,
        fundingTime: ts,
        fundingAmount: amount,
        asset,
      }
    },
  }),
}

export type OkxRestAdapterOptions = BaseRestAdapterOptions

export function createOkxRestAdapter(opts: OkxRestAdapterOptions): ReturnType<typeof createCcxtRestAdapter> {
  return createCcxtRestAdapter(okxSpec, opts)
}
