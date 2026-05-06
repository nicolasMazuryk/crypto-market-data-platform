import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ExchangeRestAdapter } from '../types.js'
import type { CcxtExchange, CcxtOrder } from '../../../../exchanges/types.js'
import type { RateLimiter } from '../../../core/types.js'
import type { Exchange } from '../../../types/exchange.js'

export interface RestConformanceFixtures {
  exchange: Exchange
  makeAdapter(ccxtOverrides?: Partial<CcxtExchange>): {
    adapter: ExchangeRestAdapter & { dispose?(): Promise<void> }
    ccxt: CcxtExchange
    limiter: RateLimiter & { acquire: ReturnType<typeof vi.fn> }
  }
  duplicateOrderCode: string
  sampleSymbol: string // normalized, e.g., 'BTCUSDT'
  sampleCcxtSymbol: string // CCXT unified, e.g., 'BTC/USDT:USDT'
  clientOrderIdParam: string // param name for client order id in create
  transformClientOrderId?: (id: string) => string // exchange-specific sanitization (e.g. OKX strips dashes)
}

export function runRestAdapterConformance(fixtures: RestConformanceFixtures): void {
  describe(`${fixtures.exchange} REST conformance`, () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('createOrder happy path: returns accepted ack with exchangeOrderId', async () => {
      const { adapter } = fixtures.makeAdapter()
      const ack = await adapter.createOrder({
        intentId: 'i1',
        clientOrderId: 'cid-1',
        exchange: fixtures.exchange,
        symbol: fixtures.sampleSymbol,
        side: 'buy',
        type: 'market',
        qty: 0.001,
      })
      expect(ack.status).toBe('accepted')
      expect(ack.exchangeOrderId).toBe('ex-123')
      expect(ack.clientOrderId).toBe('cid-1')
    })

    it('createOrder passes client order id in correct param', async () => {
      const { adapter, ccxt } = fixtures.makeAdapter()
      await adapter.createOrder({
        intentId: 'i1',
        clientOrderId: 'cid-1',
        exchange: fixtures.exchange,
        symbol: fixtures.sampleSymbol,
        side: 'buy',
        type: 'market',
        qty: 0.001,
      })
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const createOrder = ccxt.createOrder as ReturnType<typeof vi.fn>
      const expectedId = fixtures.transformClientOrderId ? fixtures.transformClientOrderId('cid-1') : 'cid-1'
      expect(createOrder).toHaveBeenCalledWith(
        fixtures.sampleCcxtSymbol,
        'market',
        'buy',
        0.001,
        undefined,
        expect.objectContaining({ [fixtures.clientOrderIdParam]: expectedId })
      )
    })

    it('createOrder: exchange rejection returns OrderAck { status: rejected }', async () => {
      const err = new Error('exchange rejected')
      err.name = 'InvalidOrder'
      const { adapter } = fixtures.makeAdapter({ createOrder: vi.fn().mockRejectedValue(err) })
      const ack = await adapter.createOrder({
        intentId: 'i1',
        clientOrderId: 'cid-1',
        exchange: fixtures.exchange,
        symbol: fixtures.sampleSymbol,
        side: 'buy',
        type: 'market',
        qty: 0.001,
      })
      expect(ack.status).toBe('rejected')
    })

    it('createOrder: duplicate code → idempotency hit, fetches existing', async () => {
      const dupErr = new Error(`exchange ${fixtures.duplicateOrderCode} Duplicate order sent`)
      dupErr.name = 'InvalidOrder'
      const existing: CcxtOrder = {
        id: 'ex-123',
        clientOrderId: 'cid-1',
        symbol: fixtures.sampleCcxtSymbol,
        side: 'buy',
        type: 'market',
        amount: 0.001,
        filled: 0,
        status: 'open',
        timestamp: 1000,
        info: {},
      }
      const { adapter } = fixtures.makeAdapter({
        createOrder: vi.fn().mockRejectedValue(dupErr),
        fetchOrder: vi.fn().mockResolvedValue(existing),
      })
      const ackPromise = adapter.createOrder({
        intentId: 'i1',
        clientOrderId: 'cid-1',
        exchange: fixtures.exchange,
        symbol: fixtures.sampleSymbol,
        side: 'buy',
        type: 'market',
        qty: 0.001,
      })
      await vi.runAllTimersAsync()
      const ack = await ackPromise
      expect(ack.status).toBe('accepted')
      expect(ack.exchangeOrderId).toBe('ex-123')
    })

    it('createOrder: retryable error → retry succeeds', async () => {
      const netErr = new Error('timeout')
      netErr.name = 'NetworkError'
      let callCount = 0
      const { adapter } = fixtures.makeAdapter({
        createOrder: vi.fn().mockImplementation(() => {
          callCount++
          if (callCount === 1) return Promise.reject(netErr)
          return Promise.resolve({
            id: 'ex-123',
            clientOrderId: 'cid-1',
            symbol: fixtures.sampleCcxtSymbol,
            side: 'buy',
            type: 'market',
            amount: 0.001,
            filled: 0,
            status: 'open',
            timestamp: 1000,
            info: {},
          })
        }),
        fetchOrder: vi.fn().mockResolvedValue(null),
      })
      const ackPromise = adapter.createOrder({
        intentId: 'i1',
        clientOrderId: 'cid-1',
        exchange: fixtures.exchange,
        symbol: fixtures.sampleSymbol,
        side: 'buy',
        type: 'market',
        qty: 0.001,
      })
      await vi.runAllTimersAsync()
      const ack = await ackPromise
      expect(ack.status).toBe('accepted')
      expect(callCount).toBe(2)
    })

    it('cancelOrder: happy path', async () => {
      const { adapter } = fixtures.makeAdapter()
      await expect(
        adapter.cancelOrder({ symbol: fixtures.sampleSymbol, clientOrderId: 'cid-1' })
      ).resolves.not.toThrow()
    })

    it('cancelOrder: OrderNotFound → no-op', async () => {
      const nfErr = new Error('not found')
      nfErr.name = 'OrderNotFound'
      const { adapter } = fixtures.makeAdapter({ cancelOrder: vi.fn().mockRejectedValue(nfErr) })
      await expect(
        adapter.cancelOrder({ symbol: fixtures.sampleSymbol, clientOrderId: 'cid-1' })
      ).resolves.not.toThrow()
    })

    it('amendOrder: happy path returns accepted ack', async () => {
      const { adapter } = fixtures.makeAdapter()
      const ack = await adapter.amendOrder({ symbol: fixtures.sampleSymbol, clientOrderId: 'cid-1' }, { price: 45000 })
      expect(ack.status).toBe('accepted')
    })

    it('getOpenOrders: returns array', async () => {
      const { adapter } = fixtures.makeAdapter({ fetchOpenOrders: vi.fn().mockResolvedValue([]) })
      const orders = await adapter.getOpenOrders(fixtures.sampleSymbol)
      expect(Array.isArray(orders)).toBe(true)
    })

    it('getPositions: returns array, filters zero-qty', async () => {
      const { adapter } = fixtures.makeAdapter({
        fetchPositions: vi.fn().mockResolvedValue([
          { symbol: fixtures.sampleCcxtSymbol, side: 'long', contracts: 0, timestamp: 1000, info: {} },
          {
            symbol: fixtures.sampleCcxtSymbol,
            side: 'long',
            contracts: 2,
            entryPrice: 50000,
            markPrice: 51000,
            leverage: 4,
            unrealizedPnl: 2000,
            liquidationPrice: 40000,
            timestamp: 1000,
            info: {},
          },
        ]),
      })
      const positions = await adapter.getPositions()
      expect(positions).toHaveLength(1)
      expect(positions[0]?.qty).toBe(2)
    })

    it('getBalance: returns USDT balance', async () => {
      const { adapter } = fixtures.makeAdapter()
      const balances = await adapter.getBalance()
      expect(balances).toHaveLength(1)
      expect(balances[0]?.asset).toBe('USDT')
    })

    it('getServerTime: returns timestamp', async () => {
      const { adapter } = fixtures.makeAdapter()
      const t = await adapter.getServerTime()
      expect(typeof t).toBe('number')
    })

    it('setLeverage: cached — second call with same leverage skips CCXT', async () => {
      const { adapter, ccxt } = fixtures.makeAdapter()
      const req = {
        intentId: 'i1',
        clientOrderId: 'cid-1',
        exchange: fixtures.exchange,
        symbol: fixtures.sampleSymbol,
        side: 'buy' as const,
        type: 'market' as const,
        qty: 0.001,
        leverage: 4,
      }
      await adapter.createOrder(req)
      await adapter.createOrder(req)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setLeverage = ccxt.setLeverage as ReturnType<typeof vi.fn>
      expect(setLeverage).toHaveBeenCalledTimes(1)
    })

    it('each method acquires the rate limiter', async () => {
      const { adapter, limiter } = fixtures.makeAdapter()
      await adapter.createOrder({
        intentId: 'i1',
        clientOrderId: 'cid-1',
        exchange: fixtures.exchange,
        symbol: fixtures.sampleSymbol,
        side: 'buy',
        type: 'market',
        qty: 0.001,
      })
      await adapter.cancelOrder({ symbol: fixtures.sampleSymbol })
      await adapter.getOpenOrders(fixtures.sampleSymbol)
      await adapter.getPositions()
      await adapter.getBalance()
      await adapter.getServerTime()
      const classes = limiter.acquire.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(classes).toContain('order_write')
      expect(classes).toContain('order_read')
      expect(classes).toContain('account_read')
      expect(classes).toContain('time')
    })
  })
}
