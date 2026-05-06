import { afterAll, describe, expect, it } from 'vitest'
import ccxt from 'ccxt'
import pino from 'pino'

import type { CcxtExchange } from '../../../../exchanges/types.js'
import { MetricsRegistry, registerRestMetrics } from '../../../observability/metrics.js'
import { createBybitRestAdapter } from '../bybit.js'

// Run with: BYBIT_LIVE_TEST=1 BYBIT_TESTNET_API_KEY=... BYBIT_TESTNET_API_SECRET=... npm test bybit.live
const LIVE = !!process.env.BYBIT_LIVE_TEST

describe.skipIf(!LIVE)('bybit live testnet SL placement', () => {
  const ccxtReg = ccxt as unknown as Record<string, new (cfg?: Record<string, unknown>) => CcxtExchange>
  const BybitCls = ccxtReg.bybit
  if (!BybitCls) throw new Error('CCXT bybit class not found')

  const ccxtEx = new BybitCls({
    apiKey: process.env.BYBIT_TESTNET_API_KEY,
    secret: process.env.BYBIT_TESTNET_API_SECRET,
    enableRateLimit: false,
    sandbox: true,
    options: { defaultType: 'swap' },
  })

  const registry = new MetricsRegistry()
  const metrics = registerRestMetrics(registry)
  const logger = pino({ level: 'warn' })

  const adapter = createBybitRestAdapter({
    config: {
      exchange: 'bybit',
      enabled: true,
      credentialsEnvPrefix: 'BYBIT',
      rateLimits: { criticalReservationFraction: 0.1, criticalWindowSeconds: 60, buckets: [] },
      marketRefreshMs: 60_000,
      fundingPullMs: 15_000,
    },
    limiter: {
      acquire: async () => {},
      reserve: () => () => {},
    },
    clock: {
      now: () => Date.now(),
      monotonic: () => Date.now(),
      skewMs: () => 0,
      recordSkew: () => {},
    },
    ids: { forIntent: () => 'test', forExit: () => 'test' },
    logger,
    metrics,
    ccxtFactory: () => ccxtEx,
  })

  let placedClientOrderId: string | undefined
  let placedExchangeOrderId: string | undefined

  it('accepts a sell-side stop_market SL with stopPrice well above current price', async () => {
    await ccxtEx.loadMarkets()
    // Use a price well above any realistic BTC value — order is accepted but never triggers
    const stopPrice = 200_000
    const clientOrderId = `live-sl-${String(Date.now())}`

    const ack = await adapter.createOrder({
      intentId: 'live-test-1',
      clientOrderId,
      exchange: 'bybit',
      symbol: 'BTCUSDT',
      side: 'sell',
      type: 'stop_market',
      qty: 0.001,
      stopPrice,
      reduceOnly: true,
    })

    placedClientOrderId = clientOrderId
    placedExchangeOrderId = ack.exchangeOrderId

    expect(ack.status).toBe('accepted')
  }, 30_000)

  it('fetchOpenOrders finds the order with triggerDirection=2 in raw info', async () => {
    if (!ccxtEx.fetchOpenOrders) throw new Error('fetchOpenOrders not available on this exchange')
    const openOrders = await ccxtEx.fetchOpenOrders('BTC/USDT:USDT')
    const order = openOrders.find(o => o.clientOrderId === placedClientOrderId)
    expect(order).toBeDefined()
    // Bybit V5 API returns triggerDirection as the string "2" in the raw response
    expect(order?.info.triggerDirection).toBe('2')
  }, 30_000)

  afterAll(async () => {
    if (placedExchangeOrderId && ccxtEx.cancelOrder) {
      try {
        await ccxtEx.cancelOrder(placedExchangeOrderId, 'BTC/USDT:USDT')
      } catch {
        // Order may have already been cancelled or expired — ignore
      }
    }
  })
})
