import { ccxtIdMap } from '../../markets/ccxtIdMap.js'
import type { OrderRequest, OrderRef } from './types.js'
import type { CcxtExchange } from '../../../exchanges/types.js'
import { createCcxtRestAdapter, type CcxtAdapterSpec, type BaseRestAdapterOptions } from './ccxt-base.js'

const binanceSpec: CcxtAdapterSpec = {
  exchange: 'binance',
  ccxtId: ccxtIdMap.binance,
  ccxtOptions: { defaultType: 'swap', adjustForTimeDifference: true, warnOnFetchOpenOrdersWithoutSymbol: false },
  duplicateOrderCodes: new Set(['-2010', '-4116']),
  leverageAlreadySetCode: '-4046',
  setPositionMode: async (ccxtEx, hedged) => {
    if (!ccxtEx.setPositionMode) return
    try {
      await ccxtEx.setPositionMode(hedged)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('-4059') || msg.includes('no need to change position side')) return
      // -4067: Binance rejects mode change (or same-mode SET) when open orders exist.
      // If the current mode already matches what we want, this is safe to ignore.
      if (msg.includes('-4067') || msg.includes('Position side cannot be changed')) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const info = (await (ccxtEx as any).fapiPrivateGetPositionSideDual?.()) as
          | { dualSidePosition: boolean }
          | undefined
        if (info?.dualSidePosition === hedged) return
      }
      throw err
    }
  },
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
  buildFetchOrderParams: (ref: OrderRef) => (ref.exchangeOrderId ? {} : { origClientOrderId: ref.clientOrderId ?? '' }),
  buildAmendOrderParams: (ref: Required<Pick<OrderRef, 'symbol' | 'clientOrderId'>>) => ({
    origClientOrderId: ref.clientOrderId,
  }),

  buildExtras(ccxtEx: CcxtExchange) {
    return {
      async fetchFundingFeeIncome(symbol: string, fundingTs: number) {
        const binanceEx = ccxtEx as unknown as {
          fapiPrivateGetIncome(
            params: Record<string, unknown>
          ): Promise<{ symbol: string; income: string; asset: string; time: number | string; incomeType: string }[]>
        }
        const rows = await binanceEx.fapiPrivateGetIncome({
          symbol,
          incomeType: 'FUNDING_FEE',
          startTime: fundingTs - 10_000,
          endTime: fundingTs + 60_000,
          limit: 10,
        })
        const match = rows.find(r => r.incomeType === 'FUNDING_FEE')
        if (!match) return null
        return {
          symbol: match.symbol,
          fundingTime: Number(match.time),
          fundingAmount: parseFloat(match.income),
          asset: match.asset,
        }
      },
    }
  },
}

export type BinanceRestAdapterOptions = BaseRestAdapterOptions

export function createBinanceRestAdapter(opts: BinanceRestAdapterOptions): ReturnType<typeof createCcxtRestAdapter> {
  return createCcxtRestAdapter(binanceSpec, opts)
}
