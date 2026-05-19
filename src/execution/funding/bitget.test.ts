import { describe, expect, it } from 'vitest'
import type { CcxtExchange } from '../../exchanges/types.js'
import { createBitgetPuller } from './bitget.js'

const EXCHANGE_SYMBOL = 'BTCUSDT'
const NORMALIZED_SYMBOL = 'BTCUSDT'

function makeMarkets() {
  return {
    [NORMALIZED_SYMBOL]: {
      id: EXCHANGE_SYMBOL,
      symbol: NORMALIZED_SYMBOL,
      type: 'swap',
      swap: true,
      linear: true,
      settle: 'USDT',
      active: true,
    },
  }
}

function makeRates(overrides: Record<string, unknown> = {}) {
  return {
    [NORMALIZED_SYMBOL]: {
      symbol: NORMALIZED_SYMBOL,
      fundingRate: -0.001,
      fundingTimestamp: Date.now() + 3_600_000,
      fundingInterval: 8 * 60,
      markPrice: undefined,
      info: { fundingRateInterval: '480' },
      ...overrides,
    },
  }
}

function makeCcxt(overrides: {
  rates?: Record<string, unknown>
  tickersData?: unknown[]
  tickersFails?: boolean
}): () => CcxtExchange {
  const { rates = makeRates(), tickersData = [], tickersFails = false } = overrides
  return () =>
    ({
      markets: makeMarkets(),
      loadMarkets: async () => makeMarkets(),
      fetchFundingRates: async () => rates,
      publicMixGetV2MixMarketTickers: tickersFails
        ? async () => {
            throw new Error('network error')
          }
        : async () => ({ data: tickersData }),
    }) as unknown as CcxtExchange
}

describe('Bitget funding puller', () => {
  it('populates markPrice from tickers when fundingRate endpoint omits it', async () => {
    const factory = makeCcxt({
      tickersData: [{ symbol: EXCHANGE_SYMBOL, markPrice: '65000' }],
    })
    const puller = createBitgetPuller(factory)
    const snapshots = await puller.pull()

    const snap = snapshots.find(s => s.symbol === NORMALIZED_SYMBOL)
    expect(snap).toBeDefined()
    expect(snap?.markPrice).toBe(65000)
  })

  it('does not overwrite valid markPrice already present in fundingRate payload', async () => {
    const factory = makeCcxt({
      rates: makeRates({ markPrice: 50000 }),
      tickersData: [{ symbol: EXCHANGE_SYMBOL, markPrice: '65000' }],
    })
    const puller = createBitgetPuller(factory)
    const snapshots = await puller.pull()

    const snap = snapshots.find(s => s.symbol === NORMALIZED_SYMBOL)
    expect(snap?.markPrice).toBe(50000)
  })

  it('still returns snapshot without markPrice when tickers call fails', async () => {
    const factory = makeCcxt({ tickersFails: true })
    const puller = createBitgetPuller(factory)
    const snapshots = await puller.pull()

    const snap = snapshots.find(s => s.symbol === NORMALIZED_SYMBOL)
    expect(snap).toBeDefined()
    expect(snap?.markPrice).toBeUndefined()
  })

  it('ignores ticker rows with zero or non-finite markPrice', async () => {
    const factory = makeCcxt({
      tickersData: [
        { symbol: EXCHANGE_SYMBOL, markPrice: '0' },
        { symbol: EXCHANGE_SYMBOL, markPrice: 'NaN' },
      ],
    })
    const puller = createBitgetPuller(factory)
    const snapshots = await puller.pull()

    const snap = snapshots.find(s => s.symbol === NORMALIZED_SYMBOL)
    expect(snap?.markPrice).toBeUndefined()
  })
})
