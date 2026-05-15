import { createCcxtExchange } from '../../exchanges/ccxt-client.js'
import type { CcxtExchange } from '../../exchanges/types.js'
import { ccxtIdMap } from '../markets/ccxtIdMap.js'
import type { Exchange } from '../types/exchange.js'
import { loadMarketsIfStale } from './ccxtMarkets.js'
import { mapCcxtFundingRate } from './mapper.js'
import type { ExchangeFundingPuller, FundingSnapshot } from './types.js'

type OkxMarkEntry = { instId: string; markPx: string }
type OkxMarkPriceResp = { data: OkxMarkEntry[] }

// OKX's fetchFundingRates response omits markPrice — fetch it from the dedicated mark-price endpoint.
async function fetchOkxMarkPrices(ccxtExchange: CcxtExchange): Promise<Map<string, number>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const resp = (await (ccxtExchange as any).publicGetPublicMarkPrice({ instType: 'SWAP' })) as OkxMarkPriceResp
  const entries = resp.data ?? []
  const map = new Map<string, number>()
  for (const d of entries) {
    const price = parseFloat(d.markPx)
    if (price > 0) map.set(d.instId, price)
  }
  return map
}

export function createOkxPuller(ccxtFactory?: () => CcxtExchange): ExchangeFundingPuller {
  const ccxtExchange = ccxtFactory ? ccxtFactory() : createCcxtExchange({ name: 'okx', ccxtId: ccxtIdMap.okx })

  let marketsLoadedAt: number | null = null

  return {
    exchange: 'okx' as Exchange,
    async pull(): Promise<FundingSnapshot[]> {
      marketsLoadedAt = await loadMarketsIfStale(ccxtExchange, marketsLoadedAt)
      if (!ccxtExchange.fetchFundingRates) {
        throw new Error('okx CCXT exchange does not support fetchFundingRates')
      }
      const [rates, markPrices] = await Promise.all([
        ccxtExchange.fetchFundingRates(),
        fetchOkxMarkPrices(ccxtExchange),
      ])
      const snapshots: FundingSnapshot[] = []
      for (const raw of Object.values(rates)) {
        const snap = mapCcxtFundingRate('okx', raw, ccxtExchange.markets)
        if (snap) {
          const instId = raw.info['instId'] as string | undefined
          if (instId) {
            const mp = markPrices.get(instId)
            if (mp !== undefined) snap.markPrice = mp
          }
          snapshots.push(snap)
        }
      }
      return snapshots
    },
  }
}
