import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOkxOrderWsAdapter } from './okx.js'

const mockSubmitNewOrder = vi.fn()
const mockCancelOrder = vi.fn()
const mockAmendOrder = vi.fn()
const mockCloseAll = vi.fn()

vi.mock('okx-api', () => ({
  WebsocketAPIClient: vi.fn().mockImplementation(() => ({
    submitNewOrder: mockSubmitNewOrder,
    cancelOrder: mockCancelOrder,
    amendOrder: mockAmendOrder,
    getWSClient: () => ({ closeAll: mockCloseAll }),
  })),
}))

describe('createOkxOrderWsAdapter', () => {
  const adapter = createOkxOrderWsAdapter({
    credentials: { apiKey: 'key', apiSecret: 'secret', apiPassphrase: 'pass' },
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await adapter.connect()
  })

  afterEach(async () => {
    await adapter.disconnect()
  })

  it('createOrder → accepted when sCode=0', async () => {
    mockSubmitNewOrder.mockResolvedValue({
      data: [{ sCode: '0', sMsg: '', clOrdId: 'cid-1', ordId: 'oid-1' }],
    })
    const ack = await adapter.createOrder({
      clientOrderId: 'cid-1',
      symbol: 'BTC-USDT-SWAP',
      side: 'buy',
      type: 'limit',
      qty: 0.01,
      price: 30000,
      reduceOnly: false,
    })
    expect(ack.status).toBe('accepted')
    expect(ack.exchangeOrderId).toBe('oid-1')
  })

  it('createOrder → rejected when sCode≠0', async () => {
    mockSubmitNewOrder.mockResolvedValue({
      data: [{ sCode: '51000', sMsg: 'Order failed', clOrdId: 'cid-2', ordId: '' }],
    })
    const ack = await adapter.createOrder({
      clientOrderId: 'cid-2',
      symbol: 'BTC-USDT-SWAP',
      side: 'sell',
      type: 'market',
      qty: 0.01,
      reduceOnly: false,
    })
    expect(ack.status).toBe('rejected')
    expect(ack.rejectReason).toContain('Order failed')
  })

  it('createOrder → rejected when SDK throws', async () => {
    mockSubmitNewOrder.mockRejectedValue(new Error('auth failed'))
    const ack = await adapter.createOrder({
      clientOrderId: 'cid-3',
      symbol: 'BTC-USDT-SWAP',
      side: 'buy',
      type: 'market',
      qty: 0.01,
      reduceOnly: false,
    })
    expect(ack.status).toBe('rejected')
    expect(ack.rejectReason).toContain('auth failed')
  })
})
