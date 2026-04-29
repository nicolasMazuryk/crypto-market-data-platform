import type { CcxtExchange } from '../../exchanges/types.js'

const MARKETS_RELOAD_MS = 10 * 60 * 1000

export async function loadMarketsIfStale(ccxtExchange: CcxtExchange, loadedAt: number | null): Promise<number> {
  const now = Date.now()
  if (loadedAt === null || now - loadedAt > MARKETS_RELOAD_MS) {
    await ccxtExchange.loadMarkets()
    return now
  }
  return loadedAt
}
