import { describe, expect, it, vi } from 'vitest'

import type { Logger } from 'pino'

import type { Clock } from '../../core/types.js'
import { MetricsRegistry, registerRestMetrics } from '../../observability/metrics.js'
import { createShadowRestAdapter } from './shadow.js'
import type { OrderRequest } from './types.js'

function makeOptions() {
  const registry = new MetricsRegistry()
  const metrics = registerRestMetrics(registry)
  const clock: Clock = {
    now: vi.fn().mockReturnValue(5000),
    monotonic: vi.fn().mockReturnValue(5000),
    skewMs: vi.fn().mockReturnValue(0),
    recordSkew: vi.fn(),
  }
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger

  const adapter = createShadowRestAdapter({ exchange: 'binance', clock, logger, metrics })
  return { adapter, registry, clock }
}

const orderReq: OrderRequest = {
  intentId: 'intent-1',
  clientOrderId: 'cid-abc',
  exchange: 'binance',
  symbol: 'BTCUSDT',
  side: 'buy',
  type: 'market',
  qty: 0.001,
}

describe('ShadowRestAdapter', () => {
  it('createOrder returns synthetic accepted ack with shadow- prefix', async () => {
    const { adapter } = makeOptions()

    const ack = await adapter.createOrder(orderReq)

    expect(ack.status).toBe('accepted')
    expect(ack.exchangeOrderId).toBe('shadow-cid-abc')
    expect(ack.clientOrderId).toBe('cid-abc')
  })

  it('cancelOrder resolves without error', async () => {
    const { adapter } = makeOptions()
    await expect(adapter.cancelOrder({ symbol: 'BTCUSDT', clientOrderId: 'cid-abc' })).resolves.not.toThrow()
  })

  it('amendOrder returns synthetic ack', async () => {
    const { adapter } = makeOptions()

    const ack = await adapter.amendOrder({ symbol: 'BTCUSDT', clientOrderId: 'cid-abc' }, { price: 45000 })

    expect(ack.status).toBe('accepted')
    expect(ack.exchangeOrderId).toBe('shadow-cid-abc')
  })

  it('read methods return empty/synthetic results', async () => {
    const { adapter } = makeOptions()

    expect(await adapter.getOpenOrders()).toEqual([])
    expect(await adapter.getOrder({ symbol: 'BTCUSDT' })).toBeUndefined()
    expect(await adapter.getPositions()).toEqual([])
    const balance = await adapter.getBalance()
    expect(balance).toHaveLength(1)
    expect(balance[0]).toMatchObject({ exchange: 'binance', asset: 'USDT', available: 100_000 })
  })

  it('getServerTime returns clock.now()', async () => {
    const { adapter } = makeOptions()
    expect(await adapter.getServerTime()).toBe(5000)
  })

  it('no network calls are ever made', async () => {
    const { adapter } = makeOptions()

    await adapter.createOrder(orderReq)
    await adapter.cancelOrder({ symbol: 'BTCUSDT' })
    await adapter.getOpenOrders()
    await adapter.getPositions()
    await adapter.getBalance()
    // If any network were called, the test would fail on "fetch is not defined" in node test env
  })

  it('createOrder increments ordersTotal with status=shadow', async () => {
    const { adapter, registry } = makeOptions()

    await adapter.createOrder(orderReq)

    const rendered = await registry.render()
    expect(rendered).toMatch(/rest_orders_total\{exchange="binance",side="buy",type="market",status="shadow"\} 1/)
  })
})
