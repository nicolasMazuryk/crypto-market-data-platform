import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createGateioOrderWsAdapter } from './gateio.js'

const mockSubmitNewFuturesOrder = vi.fn()
const mockCancelFuturesOrder = vi.fn()
const mockUpdateFuturesOrder = vi.fn()
const mockCloseAll = vi.fn()
const mockGetFuturesOrders = vi.fn()

vi.mock('gateio-api', () => ({
  WebsocketAPIClient: vi.fn().mockImplementation(() => ({
    submitNewFuturesOrder: mockSubmitNewFuturesOrder,
    cancelFuturesOrder: mockCancelFuturesOrder,
    updateFuturesOrder: mockUpdateFuturesOrder,
    getWSClient: () => ({ closeAll: mockCloseAll }),
  })),
  RestClient: vi.fn().mockImplementation(() => ({
    getFuturesOrders: mockGetFuturesOrders,
  })),
}))

describe('createGateioOrderWsAdapter', () => {
  const adapter = createGateioOrderWsAdapter({
    credentials: { apiKey: 'key', apiSecret: 'secret' },
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await adapter.connect()
  })

  afterEach(async () => {
    await adapter.disconnect()
  })

  it('createOrder buy → positive size sent to SDK, accepted on success', async () => {
    mockSubmitNewFuturesOrder.mockResolvedValue({
      data: { result: { id: 99999, text: 't-cid-1' } },
    })
    const ack = await adapter.createOrder({
      clientOrderId: 'cid-1',
      symbol: 'BTC_USDT',
      side: 'buy',
      type: 'limit',
      qty: 5,
      price: 30000,
      reduceOnly: false,
    })
    expect(ack.status).toBe('accepted')
    expect(ack.clientOrderId).toBe('cid-1')
    expect(ack.exchangeOrderId).toBe('99999')
    // Verify positive size for buy
    const callArgs = mockSubmitNewFuturesOrder.mock.calls[0]?.[0] as { size: number }
    expect(callArgs.size).toBeGreaterThan(0)
  })

  it('createOrder sell → negative size sent to SDK', async () => {
    mockSubmitNewFuturesOrder.mockResolvedValue({
      data: { result: { id: 88888, text: 't-cid-2' } },
    })
    await adapter.createOrder({
      clientOrderId: 'cid-2',
      symbol: 'BTC_USDT',
      side: 'sell',
      type: 'market',
      qty: 5,
      reduceOnly: false,
    })
    const callArgs = mockSubmitNewFuturesOrder.mock.calls[0]?.[0] as { size: number }
    expect(callArgs.size).toBeLessThan(0)
  })

  it('createOrder → REST fallback resolves ID when WS ack has no id (Gate.io two-phase response)', async () => {
    // Simulate Gate.io WS ack: request echo without order ID
    mockSubmitNewFuturesOrder.mockResolvedValue({
      ack: true,
      data: { result: { req_id: '1', req_param: { text: 't-cid-fb' } } },
    })
    mockGetFuturesOrders
      .mockResolvedValueOnce([]) // finished — not found yet
      .mockResolvedValueOnce([]) // open — not found yet
      .mockResolvedValueOnce([{ id: 77777, text: 't-cid-fb' }]) // finished — found
    const ack = await adapter.createOrder({
      clientOrderId: 'cid-fb',
      symbol: 'BTC_USDT',
      side: 'buy',
      type: 'market',
      qty: 1,
      reduceOnly: false,
    })
    expect(ack.status).toBe('accepted')
    expect(ack.exchangeOrderId).toBe('77777')
    expect(ack.clientOrderId).toBe('cid-fb')
  })

  it('createOrder → rejected when SDK throws', async () => {
    mockSubmitNewFuturesOrder.mockRejectedValue(new Error('connection lost'))
    const ack = await adapter.createOrder({
      clientOrderId: 'cid-3',
      symbol: 'BTC_USDT',
      side: 'buy',
      type: 'market',
      qty: 5,
      reduceOnly: false,
    })
    expect(ack.status).toBe('rejected')
    expect(ack.rejectReason).toContain('connection lost')
  })
})
