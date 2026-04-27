import type { ExchangeConfig } from '../../config/types.js'
import { createEventBus } from '../../core/bus.js'
import { createClock } from '../../core/clock.js'
import { createExecutionLogger } from '../../core/logger.js'
import { MetricsRegistry, registerPrivateWsMetrics } from '../../observability/metrics.js'
import { createBybitPrivateWsAdapter } from './bybit.js'
import { runWsAdapterConformance } from './__tests__/conformance.js'

function makeConfig(): ExchangeConfig {
  return {
    exchange: 'bybit',
    enabled: true,
    credentialsEnvPrefix: 'BYBIT',
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
  exchange: 'bybit',
  createAdapter: (clientFactory) => {
    const adapterOpts: Parameters<typeof createBybitPrivateWsAdapter>[0] = {
      config: makeConfig(),
      bus,
      clock,
      logger,
      metrics,
    }
    if (clientFactory) adapterOpts.wsClientFactory = clientFactory
    return createBybitPrivateWsAdapter(adapterOpts)
  },
  sampleOrderRaw: {
    topic: 'order',
    data: [
      {
        orderId: 'ex-123',
        orderLinkId: 'cid-1',
        symbol: 'BTCUSDT',
        side: 'Buy',
        orderType: 'Limit',
        qty: '0.001',
        price: '30000',
        avgPrice: '0',
        orderStatus: 'New',
        cumExecQty: '0',
        reduceOnly: false,
        createdTime: '1000',
        updatedTime: '1000',
      },
    ],
  },
  samplePositionRaw: {
    topic: 'position',
    data: [
      {
        symbol: 'BTCUSDT',
        side: 'Buy',
        size: '0.001',
        avgPrice: '30000',
        unrealisedPnl: '10',
        leverage: '4',
        liqPrice: '20000',
        updatedTime: '1000',
      },
    ],
  },
  sampleBalanceRaw: {
    topic: 'wallet',
    data: [
      {
        coin: [
          {
            coin: 'USDT',
            availableToWithdraw: '1000',
            walletBalance: '1050',
          },
        ],
      },
    ],
  },
})
