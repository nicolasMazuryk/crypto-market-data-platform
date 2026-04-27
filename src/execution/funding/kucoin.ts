import type { Exchange } from '../types/exchange.js'
import type { FundingInterval } from '../types/exchange.js'
import { normalizeSymbol } from '../../utils/symbol-normalizer.js'
import type { ExchangeFundingPuller, FundingSnapshot } from './types.js'

const KUCOIN_DEFAULT_FUNDING_INTERVAL: FundingInterval = 8

export function createKucoinPuller(): ExchangeFundingPuller {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any = null

  return {
    exchange: 'kucoin' as Exchange,
    async pull(): Promise<FundingSnapshot[]> {
      if (!client) {
        const { FuturesClient } = await import('kucoin-api')
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
        client = new FuturesClient()
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const resp = await client.getSymbols()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const symbols: import('kucoin-api').FuturesSymbolInfo[] = resp.data ?? []

      const snapshots: FundingSnapshot[] = []
      const now = Date.now()

      for (const s of symbols) {
        // Linear USDT-margined perpetuals only
        if (s.settleCurrency !== 'USDT') continue
        if (s.expireDate !== null) continue // skip dated futures

        const normalizedSymbol = normalizeSymbol(s.symbol)
        if (!normalizedSymbol.endsWith('USDT')) continue

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        const fundingRate = s.predictedFundingFeeRate ?? 0
        const nextFundingTimestamp = s.nextFundingRateTime ?? now + 8 * 3600 * 1000

        snapshots.push({
          exchange: 'kucoin' as Exchange,
          symbol: normalizedSymbol,
          exchangeSymbol: s.symbol,
          fundingRate,
          fundingRatePercent: fundingRate * 100,
          fundingInterval: KUCOIN_DEFAULT_FUNDING_INTERVAL,
          nextFundingTimestamp,
          nextFundingDatetime: new Date(nextFundingTimestamp).toISOString(),
          timestamp: now,
        })
      }

      return snapshots
    },
  }
}
