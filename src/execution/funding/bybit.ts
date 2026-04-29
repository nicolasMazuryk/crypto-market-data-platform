import { createCcxtExchange } from '../../exchanges/ccxt-client.js'
import type { CcxtExchange } from '../../exchanges/types.js'
import { ccxtIdMap } from '../markets/ccxtIdMap.js'
import type { Exchange } from '../types/exchange.js'
import { loadMarketsIfStale } from './ccxtMarkets.js'
import { mapCcxtFundingRate } from './mapper.js'
import type { ExchangeFundingPuller, FundingSnapshot } from './types.js'

export function createBybitPuller(ccxtFactory?: () => CcxtExchange): ExchangeFundingPuller {
  const ccxtExchange = ccxtFactory ? ccxtFactory() : createCcxtExchange({ name: 'bybit', ccxtId: ccxtIdMap.bybit })

  let marketsLoadedAt: number | null = null

  return {
    exchange: 'bybit' as Exchange,
    async pull(): Promise<FundingSnapshot[]> {
      marketsLoadedAt = await loadMarketsIfStale(ccxtExchange, marketsLoadedAt)
      if (!ccxtExchange.fetchFundingRates) {
        throw new Error('bybit CCXT exchange does not support fetchFundingRates')
      }
      const rates = await ccxtExchange.fetchFundingRates()
      const snapshots: FundingSnapshot[] = []
      for (const raw of Object.values(rates)) {
        const snap = mapCcxtFundingRate('bybit', raw, ccxtExchange.markets)
        if (snap) snapshots.push(snap)
      }
      return snapshots
    },
  }
}
