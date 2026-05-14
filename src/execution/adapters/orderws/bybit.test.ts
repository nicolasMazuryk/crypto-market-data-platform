import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBybitOrderWsAdapter } from './bybit.js'

const mockSubmitNewOrder = vi.fn()
const mockAmendOrder = vi.fn()
const mockCancelOrder = vi.fn()
const mockCloseAll = vi.fn()

vi.mock('bybit-api', () => ({
  WebsocketAPIClient: vi.fn().mockImplementation(() => ({
    submitNewOrder: mockSubmitNewOrder,
    amendOrder: mockAmendOrder,
    cancelOrder: mockCancelOrder,
    getWSClient: () => ({ closeAll: mockCloseAll }),
  })),
}))

describe('createBybitOrderWsAdapter', () => {
  const adapter = createBybitOrderWsAdapter({
    credentials: { apiKey: 'key', apiSecret: 'secret' },
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await adapter.connect()
  })

  afterEach(async () => {
    await adapter.disconnect()
  })

  it('createOrder → accepted when retCode=0', async () => {
    mockSubmitNewOrder.mockResolvedValue({
      retCode: 0,
      retMsg: 'OK',
      data: { orderId: 'oid-1', orderLinkId: 'cid-1' },
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
    expect(ack.exchangeOrderId).toBe('oid-1')
  })

  it('createOrder → rejected when retCode≠0', async () => {
    mockSubmitNewOrder.mockResolvedValue({
      retCode: 10001,
      retMsg: 'insufficient balance',
      data: {},
    })
    const ack = await adapter.createOrder({
      clientOrderId: 'cid-2',
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'market',
      qty: 0.001,
      reduceOnly: false,
    })
    expect(ack.status).toBe('rejected')
    expect(ack.rejectReason).toContain('insufficient balance')
  })

  it('createOrder → rejected when SDK throws', async () => {
    mockSubmitNewOrder.mockRejectedValue(new Error('network error'))
    const ack = await adapter.createOrder({
      clientOrderId: 'cid-3',
      symbol: 'BTCUSDT',
      side: 'sell',
      type: 'market',
      qty: 0.001,
      reduceOnly: false,
    })
    expect(ack.status).toBe('rejected')
    expect(ack.rejectReason).toContain('network error')
  })
})
