import { describe, expect, it } from 'vitest'

import type { CcxtExchange, CcxtFundingRate, CcxtMarket } from '../../exchanges/types.js'
import { createOkxPuller } from './okx.js'

const UNIFIED_SYMBOL = 'BTC/USDT:USDT'
const INST_ID = 'BTC-USDT-SWAP'

const MARKET: CcxtMarket = {
  id: INST_ID,
  symbol: UNIFIED_SYMBOL,
  swap: true,
  linear: true,
  settle: 'USDT',
  active: true,
}

const FUNDING_RATE: CcxtFundingRate = {
  symbol: UNIFIED_SYMBOL,
  fundingRate: 0.0001,
  fundingTimestamp: 1_700_000_000_000,
  fundingDatetime: new Date(1_700_000_000_000).toISOString(),
  interval: '8h',
  info: { instId: INST_ID },
}

function makeMockExchange(markPx: string | undefined): CcxtExchange {
  return {
    markets: { [UNIFIED_SYMBOL]: MARKET },
    loadMarkets: () => Promise.resolve({ [UNIFIED_SYMBOL]: MARKET }),
    market: () => MARKET,
    fetchFundingRates: () => Promise.resolve({ [UNIFIED_SYMBOL]: FUNDING_RATE }),
    publicGetPublicMarkPrice: () =>
      Promise.resolve({
        data: markPx !== undefined ? [{ instId: INST_ID, markPx }] : [],
      }),
  } as unknown as CcxtExchange
}

describe('OKX funding puller', () => {
  it('injects markPrice from mark-price endpoint into snapshot', async () => {
    const puller = createOkxPuller(() => makeMockExchange('65000.5'))
    const snapshots = await puller.pull()

    const snap = snapshots.find(s => s.symbol === 'BTCUSDT')
    expect(snap).toBeDefined()
    expect(snap?.markPrice).toBeCloseTo(65000.5)
  })

  it('omits markPrice when mark-price endpoint returns no entry for symbol', async () => {
    const puller = createOkxPuller(() => makeMockExchange(undefined))
    const snapshots = await puller.pull()

    const snap = snapshots.find(s => s.symbol === 'BTCUSDT')
    expect(snap).toBeDefined()
    expect(snap?.markPrice).toBeUndefined()
  })

  it('omits markPrice when markPx is zero or invalid', async () => {
    const puller = createOkxPuller(() => makeMockExchange('0'))
    const snapshots = await puller.pull()

    const snap = snapshots.find(s => s.symbol === 'BTCUSDT')
    expect(snap?.markPrice).toBeUndefined()
  })
})
