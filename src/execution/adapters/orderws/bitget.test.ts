import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBitgetOrderWsAdapter } from './bitget.js'

const mockSubmitNewOrder = vi.fn()
const mockCancelOrder = vi.fn()
const mockCloseAll = vi.fn()

vi.mock('bitget-api', () => ({
  WebsocketAPIClient: vi.fn().mockImplementation(() => ({
    submitNewOrder: mockSubmitNewOrder,
    cancelOrder: mockCancelOrder,
    getWSClient: () => ({ closeAll: mockCloseAll }),
  })),
}))

describe('createBitgetOrderWsAdapter', () => {
  const adapter = createBitgetOrderWsAdapter({
    credentials: { apiKey: 'key', apiSecret: 'secret', apiPassphrase: 'pass' },
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await adapter.connect()
  })

  afterEach(async () => {
    await adapter.disconnect()
  })

  it('createOrder → accepted when code=0', async () => {
    mockSubmitNewOrder.mockResolvedValue({
      code: '0',
      msg: 'success',
      args: [{ orderId: 'oid-1', clientOid: 'cid-1' }],
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

  it('createOrder → rejected when code≠0', async () => {
    mockSubmitNewOrder.mockResolvedValue({
      code: '40001',
      msg: 'invalid symbol',
      args: [],
    })
    const ack = await adapter.createOrder({
      clientOrderId: 'cid-2',
      symbol: 'INVALID',
      side: 'buy',
      type: 'market',
      qty: 0.001,
      reduceOnly: false,
    })
    expect(ack.status).toBe('rejected')
    expect(ack.rejectReason).toContain('invalid symbol')
  })

  it('amendOrder → always returns rejected (not supported on Bitget WS)', async () => {
    const ack = await adapter.amendOrder({ symbol: 'BTCUSDT', clientOrderId: 'cid-1' }, { price: 31000 })
    expect(ack.status).toBe('rejected')
    expect(ack.rejectReason).toContain('not supported')
  })
})
