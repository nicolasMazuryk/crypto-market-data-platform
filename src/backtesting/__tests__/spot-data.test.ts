import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fetchOrderbookWindow before importing spot-data
const mockFetchOrderbookWindow = vi.fn()
vi.mock('../data/orderbook-window.js', () => ({
  fetchOrderbookWindow: mockFetchOrderbookWindow,
}))

const { fetchSpotOrderbookWindow } = await import('../data/spot-data.js')

describe('fetchSpotOrderbookWindow — alias mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates to fetchOrderbookWindow with identical arguments', async () => {
    const mockWindow = { length: 0 }
    mockFetchOrderbookWindow.mockResolvedValue(mockWindow)

    const exchange = 'binance'
    const symbol = 'BTCUSDT'
    const fundingTime = new Date('2025-01-01T00:00:00Z')
    const windowConfig = { pre_funding_seconds: 60, post_funding_seconds: 120 }

    const result = await fetchSpotOrderbookWindow(exchange, symbol, fundingTime, windowConfig)

    expect(mockFetchOrderbookWindow).toHaveBeenCalledOnce()
    expect(mockFetchOrderbookWindow).toHaveBeenCalledWith(exchange, symbol, fundingTime, windowConfig)
    expect(result).toBe(mockWindow)
  })

  it('returns the same result as fetchOrderbookWindow when spot_exchange == perp_exchange', async () => {
    const sentinelWindow = { length: 42 }
    mockFetchOrderbookWindow.mockResolvedValue(sentinelWindow)

    const result = await fetchSpotOrderbookWindow('bybit', 'ETHUSDT', new Date('2025-06-01T08:00:00Z'), {
      pre_funding_seconds: 30,
      post_funding_seconds: 60,
    })

    expect(result).toBe(sentinelWindow)
  })
})
