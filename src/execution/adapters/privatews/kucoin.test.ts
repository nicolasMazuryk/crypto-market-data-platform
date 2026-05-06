import type { ExchangeConfig } from '../../config/types.js'
import { createEventBus } from '../../core/bus.js'
import { createClock } from '../../core/clock.js'
import { createExecutionLogger } from '../../core/logger.js'
import { MetricsRegistry, registerPrivateWsMetrics } from '../../observability/metrics.js'
import { createKucoinPrivateWsAdapter } from './kucoin.js'
import { runWsAdapterConformance } from './__tests__/conformance.js'

function makeConfig(): ExchangeConfig {
  return {
    exchange: 'kucoin',
    enabled: true,
    credentialsEnvPrefix: 'KUCOIN',
    rateLimits: { criticalReservationFraction: 0.1, criticalWindowSeconds: 1, buckets: [] },
    marketRefreshMs: 60000,
    fundingPullMs: 60000,
  }
}

const bus = createEventBus()
const clock = createClock()
const logger = createExecutionLogger()
const registry = new MetricsRegistry()
const metrics = registerPrivateWsMetrics(registry)

runWsAdapterConformance({
  exchange: 'kucoin',
  createAdapter: clientFactory => {
    const adapterOpts: Parameters<typeof createKucoinPrivateWsAdapter>[0] = {
      config: makeConfig(),
      bus,
      clock,
      logger,
      metrics,
    }
    if (clientFactory) adapterOpts.wsClientFactory = clientFactory
    return createKucoinPrivateWsAdapter(adapterOpts)
  },
  sampleOrderRaw: {
    topic: '/contractMarket/tradeOrders',
    subject: 'orderChange',
    data: {
      orderId: 'ex-123',
      clientOid: 'cid-1',
      symbol: 'XBTUSDTM',
      side: 'buy',
      orderType: 'limit',
      price: '30000',
      size: 1,
      filledSize: 0,
      status: 'open',
      type: 'open',
      reduceOnly: false,
      createdAt: 1000,
      ts: '1000000000',
    },
  },
  samplePositionRaw: {
    topic: '/contract/position:XBTUSDTM',
    subject: 'position.change',
    data: {
      symbol: 'XBTUSDTM',
      currentQty: 1,
      avgEntryPrice: 30000,
      unrealisedPnl: 10,
      liquidationPrice: 20000,
      realLeverage: 4,
      changeReason: 'positionChange',
    },
  },
  sampleBalanceRaw: {
    topic: '/contractAccount/wallet',
    subject: 'availableBalance.change',
    data: {
      currency: 'USDT',
      availableBalance: '1000',
      holdBalance: '50',
    },
  },
})
