import type { FuturesSymbolInfo } from 'kucoin-api'
import type { Exchange } from '../types/exchange.js'
import type { FundingInterval } from '../types/exchange.js'
import { normalizeSymbol } from '../../utils/symbol-normalizer.js'
import type { ExchangeFundingPuller, FundingSnapshot } from './types.js'

const KUCOIN_DEFAULT_FUNDING_INTERVAL: FundingInterval = 8
const EPOCH_MILLISECONDS_FLOOR = 1_000_000_000_000
const DEFAULT_NEXT_FUNDING_DELAY_MS = 8 * 3600 * 1000
const COUNTDOWN_FUNDING_BOUNDARY_MS = 60_000

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function resolveNextFundingTimestamp(value: unknown, now: number): number {
  const raw = finiteNumber(value)
  if (raw === undefined) return now + DEFAULT_NEXT_FUNDING_DELAY_MS
  if (raw >= EPOCH_MILLISECONDS_FLOOR) return raw
  const absolute = now + raw
  return Math.round(absolute / COUNTDOWN_FUNDING_BOUNDARY_MS) * COUNTDOWN_FUNDING_BOUNDARY_MS
}

export function createKucoinPuller(): ExchangeFundingPuller {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any = null

  return {
    exchange: 'kucoin' as Exchange,
    async pull(): Promise<FundingSnapshot[]> {
      if (!client) {
        const { FuturesClient } = await import('kucoin-api')

        client = new FuturesClient()
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const resp = await client.getSymbols()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const symbols: FuturesSymbolInfo[] = resp.data ?? []

      const snapshots: FundingSnapshot[] = []
      const now = Date.now()

      for (const s of symbols) {
        // Linear USDT-margined perpetuals only
        if (s.settleCurrency !== 'USDT') continue
        if (s.expireDate !== null) continue // skip dated futures

        const normalizedSymbol = normalizeSymbol(s.symbol)
        if (!normalizedSymbol.endsWith('USDT')) continue

        const fundingRate = finiteNumber(s.predictedFundingFeeRate) ?? finiteNumber(s.fundingFeeRate) ?? 0
        const nextFundingTimestamp = resolveNextFundingTimestamp(s.nextFundingRateTime, now)

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
          ...(s.markPrice > 0 ? { markPrice: s.markPrice } : {}),
        })
      }

      return snapshots
    },
  }
}
