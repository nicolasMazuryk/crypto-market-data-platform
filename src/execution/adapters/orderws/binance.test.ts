import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBinanceOrderWsAdapter } from './binance.js'

// Mock the binance SDK
vi.mock('binance', () => {
  const submitNewFuturesOrder = vi.fn()
  const modifyFuturesOrder = vi.fn()
  const cancelFuturesOrder = vi.fn()
  const disconnectAll = vi.fn().mockResolvedValue(undefined)
  return {
    WebsocketAPIClient: vi.fn().mockImplementation(() => ({
      submitNewFuturesOrder,
      modifyFuturesOrder,
      cancelFuturesOrder,
      disconnectAll,
    })),
  }
})

describe('createBinanceOrderWsAdapter', () => {
  const adapter = createBinanceOrderWsAdapter({
    credentials: { apiKey: 'key', apiSecret: 'secret' },
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await adapter.connect()
  })

  afterEach(async () => {
    await adapter.disconnect()
  })

  it('createOrder → accepted when SDK resolves', async () => {
    const { WebsocketAPIClient } = await import('binance')
    const sdkInst = vi.mocked(WebsocketAPIClient).mock.results[0]?.value as {
      submitNewFuturesOrder: ReturnType<typeof vi.fn>
    }
    sdkInst.submitNewFuturesOrder.mockResolvedValue({
      result: { orderId: 12345, clientOrderId: 'cid-1' },
    })
    const ack = await adapter.createOrder({
      clientOrderId: 'cid-1',
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'limit',
      qty: 0.001,
      price: 30000,
      reduceOnly: false,
    })
    expect(ack.status).toBe('accepted')
    expect(ack.clientOrderId).toBe('cid-1')
    expect(ack.exchangeOrderId).toBe('12345')
  })

  it('createOrder → rejected when SDK rejects', async () => {
    const { WebsocketAPIClient } = await import('binance')
    const sdkInst = vi.mocked(WebsocketAPIClient).mock.results[0]?.value as {
      submitNewFuturesOrder: ReturnType<typeof vi.fn>
    }
    sdkInst.submitNewFuturesOrder.mockRejectedValue(new Error('insufficient margin'))
    const ack = await adapter.createOrder({
      clientOrderId: 'cid-2',
      symbol: 'BTCUSDT',
      side: 'sell',
      type: 'market',
      qty: 0.001,
      reduceOnly: true,
    })
    expect(ack.status).toBe('rejected')
    expect(ack.rejectReason).toContain('insufficient margin')
  })

  it('createOrder → WS_TIMEOUT when SDK hangs', async () => {
    vi.useFakeTimers()
    const { WebsocketAPIClient } = await import('binance')
    const sdkInst = vi.mocked(WebsocketAPIClient).mock.results[0]?.value as {
      submitNewFuturesOrder: ReturnType<typeof vi.fn>
    }
    sdkInst.submitNewFuturesOrder.mockReturnValue(
      new Promise(() => {
        /* never resolves */
      })
    )
    const ackPromise = adapter.createOrder({
      clientOrderId: 'cid-3',
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'market',
      qty: 0.001,
      reduceOnly: false,
    })
    vi.advanceTimersByTime(6000)
    const ack = await ackPromise
    expect(ack.status).toBe('rejected')
    expect(ack.rejectReason).toBe('WS_TIMEOUT')
    vi.useRealTimers()
  })
})
