import { createCcxtExchange } from '../../exchanges/ccxt-client.js'
import type { CcxtExchange } from '../../exchanges/types.js'
import { ccxtIdMap } from '../markets/ccxtIdMap.js'
import type { Exchange } from '../types/exchange.js'
import { loadMarketsIfStale } from './ccxtMarkets.js'
import { mapCcxtFundingRate } from './mapper.js'
import type { ExchangeFundingPuller, FundingSnapshot } from './types.js'

export function createBinancePuller(ccxtFactory?: () => CcxtExchange): ExchangeFundingPuller {
  const ccxtExchange = ccxtFactory ? ccxtFactory() : createCcxtExchange({ name: 'binance', ccxtId: ccxtIdMap.binance })

  let marketsLoadedAt: number | null = null

  return {
    exchange: 'binance' as Exchange,
    async pull(): Promise<FundingSnapshot[]> {
      marketsLoadedAt = await loadMarketsIfStale(ccxtExchange, marketsLoadedAt)
      if (!ccxtExchange.fetchFundingRates) {
        throw new Error('binanceusdm CCXT exchange does not support fetchFundingRates')
      }
      const rates = await ccxtExchange.fetchFundingRates()
      const snapshots: FundingSnapshot[] = []
      for (const raw of Object.values(rates)) {
        const snap = mapCcxtFundingRate('binance', raw, ccxtExchange.markets)
        if (snap) snapshots.push(snap)
      }
      return snapshots
    },
  }
}
