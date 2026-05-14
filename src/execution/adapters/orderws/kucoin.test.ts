import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createKucoinOrderWsAdapter } from './kucoin.js'

const mockSubmitFuturesOrder = vi.fn()
const mockCancelFuturesOrder = vi.fn()
const mockCloseAll = vi.fn()

vi.mock('kucoin-api', () => ({
  WebsocketAPIClient: vi.fn().mockImplementation(() => ({
    submitFuturesOrder: mockSubmitFuturesOrder,
    cancelFuturesOrder: mockCancelFuturesOrder,
    getWSClient: () => ({ closeAll: mockCloseAll }),
  })),
}))

describe('createKucoinOrderWsAdapter', () => {
  const adapter = createKucoinOrderWsAdapter({
    credentials: { apiKey: 'key', apiSecret: 'secret', apiPassphrase: 'pass' },
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await adapter.connect()
  })

  afterEach(async () => {
    await adapter.disconnect()
  })

  it('createOrder → accepted when code=200000', async () => {
    mockSubmitFuturesOrder.mockResolvedValue({
      code: '200000',
      msg: 'success',
      data: { orderId: 'oid-1', clientOid: 'cid-1' },
    })
    const ack = await adapter.createOrder({
      clientOrderId: 'cid-1',
      symbol: 'XBTUSDTM',
      side: 'buy',
      type: 'limit',
      qty: 1,
      price: 30000,
      reduceOnly: false,
    })
    expect(ack.status).toBe('accepted')
    expect(ack.clientOrderId).toBe('cid-1')
    expect(ack.exchangeOrderId).toBe('oid-1')
  })

  it('createOrder → rejected when code≠200000', async () => {
    mockSubmitFuturesOrder.mockResolvedValue({
      code: '300004',
      msg: 'insufficient balance',
      data: {},
    })
    const ack = await adapter.createOrder({
      clientOrderId: 'cid-2',
      symbol: 'XBTUSDTM',
      side: 'buy',
      type: 'market',
      qty: 1,
      reduceOnly: false,
    })
    expect(ack.status).toBe('rejected')
    expect(ack.rejectReason).toContain('insufficient balance')
  })

  it('createOrder → rejected when SDK throws', async () => {
    mockSubmitFuturesOrder.mockRejectedValue(new Error('auth expired'))
    const ack = await adapter.createOrder({
      clientOrderId: 'cid-3',
      symbol: 'XBTUSDTM',
      side: 'sell',
      type: 'market',
      qty: 1,
      reduceOnly: false,
    })
    expect(ack.status).toBe('rejected')
    expect(ack.rejectReason).toContain('auth expired')
  })

  it('amendOrder → always returns rejected (not supported on KuCoin WS)', async () => {
    const ack = await adapter.amendOrder(
      { symbol: 'XBTUSDTM', clientOrderId: 'cid-1' },
      { price: 31000 }
    )
    expect(ack.status).toBe('rejected')
    expect(ack.rejectReason).toContain('not supported')
  })
})
