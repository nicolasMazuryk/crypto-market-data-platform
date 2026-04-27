import { createCcxtExchange } from '../../exchanges/ccxt-client.js'
import type { CcxtExchange } from '../../exchanges/types.js'
import { ccxtIdMap } from '../markets/ccxtIdMap.js'
import type { Exchange } from '../types/exchange.js'
import { mapCcxtFundingRate } from './mapper.js'
import type { ExchangeFundingPuller, FundingSnapshot } from './types.js'

export function createOkxPuller(ccxtFactory?: () => CcxtExchange): ExchangeFundingPuller {
  const ccxtExchange = ccxtFactory ? ccxtFactory() : createCcxtExchange({ name: 'okx', ccxtId: ccxtIdMap.okx })

  let marketsLoaded = false

  return {
    exchange: 'okx' as Exchange,
    async pull(): Promise<FundingSnapshot[]> {
      if (!marketsLoaded) {
        await ccxtExchange.loadMarkets()
        marketsLoaded = true
      }
      if (!ccxtExchange.fetchFundingRates) {
        throw new Error('okx CCXT exchange does not support fetchFundingRates')
      }
      const rates = await ccxtExchange.fetchFundingRates()
      const snapshots: FundingSnapshot[] = []
      for (const raw of Object.values(rates)) {
        const snap = mapCcxtFundingRate('okx', raw, ccxtExchange.markets)
        if (snap) snapshots.push(snap)
      }
      return snapshots
    },
  }
}
