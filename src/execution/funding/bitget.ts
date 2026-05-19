import { createCcxtExchange } from '../../exchanges/ccxt-client.js'
import type { CcxtExchange } from '../../exchanges/types.js'
import { ccxtIdMap } from '../markets/ccxtIdMap.js'
import type { Exchange } from '../types/exchange.js'
import { loadMarketsIfStale } from './ccxtMarkets.js'
import { mapCcxtFundingRate } from './mapper.js'
import type { ExchangeFundingPuller, FundingSnapshot } from './types.js'

interface BitgetTickerRow {
  symbol?: string
  markPrice?: string | number
}
interface BitgetTickersResponse {
  data?: BitgetTickerRow[]
}
interface BitgetCcxtExtras {
  publicMixGetV2MixMarketTickers?: (params: Record<string, unknown>) => Promise<BitgetTickersResponse>
}

export function createBitgetPuller(ccxtFactory?: () => CcxtExchange): ExchangeFundingPuller {
  const ccxtExchange = ccxtFactory ? ccxtFactory() : createCcxtExchange({ name: 'bitget', ccxtId: ccxtIdMap.bitget })

  let marketsLoadedAt: number | null = null

  return {
    exchange: 'bitget' as Exchange,
    async pull(): Promise<FundingSnapshot[]> {
      marketsLoadedAt = await loadMarketsIfStale(ccxtExchange, marketsLoadedAt)
      if (!ccxtExchange.fetchFundingRates) {
        throw new Error('bitget CCXT exchange does not support fetchFundingRates')
      }
      const tickersFn = (ccxtExchange as unknown as BitgetCcxtExtras).publicMixGetV2MixMarketTickers
      const [rates, tickers] = await Promise.all([
        ccxtExchange.fetchFundingRates(undefined, {
          method: 'publicMixGetV2MixMarketCurrentFundRate',
          productType: 'USDT-FUTURES',
        }),
        tickersFn
          ? tickersFn.call(ccxtExchange, { productType: 'USDT-FUTURES' }).catch(() => ({ data: [] }))
          : Promise.resolve({ data: [] }),
      ])

      const markPriceById = new Map<string, number>()
      for (const row of tickers.data ?? []) {
        if (typeof row.symbol !== 'string') continue
        const n = typeof row.markPrice === 'number' ? row.markPrice : Number(row.markPrice)
        if (Number.isFinite(n) && n > 0) markPriceById.set(row.symbol, n)
      }

      const snapshots: FundingSnapshot[] = []
      for (const raw of Object.values(rates)) {
        const market = ccxtExchange.markets[raw.symbol]
        if (market) {
          const fromTickers = markPriceById.get(market.id)
          const existing = typeof raw.markPrice === 'number' ? raw.markPrice : undefined
          if (fromTickers !== undefined && (existing === undefined || !Number.isFinite(existing) || existing <= 0)) {
            ;(raw as { markPrice?: number }).markPrice = fromTickers
          }
        }
        const snap = mapCcxtFundingRate('bitget', raw, ccxtExchange.markets)
        if (snap) snapshots.push(snap)
      }
      return snapshots
    },
  }
}
