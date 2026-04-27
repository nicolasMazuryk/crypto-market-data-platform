import type { ExchangeConfig } from '../../config/types.js'
import { createEventBus } from '../../core/bus.js'
import { createClock } from '../../core/clock.js'
import { createExecutionLogger } from '../../core/logger.js'
import { MetricsRegistry, registerPrivateWsMetrics } from '../../observability/metrics.js'
import { createGateioPrivateWsAdapter } from './gateio.js'
import { runWsAdapterConformance } from './__tests__/conformance.js'

function makeConfig(): ExchangeConfig {
  return {
    exchange: 'gateio',
    enabled: true,
    credentialsEnvPrefix: 'GATEIO',
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
  exchange: 'gateio',
  createAdapter: (clientFactory) => {
    const adapterOpts: Parameters<typeof createGateioPrivateWsAdapter>[0] = {
      config: makeConfig(),
      bus,
      clock,
      logger,
      metrics,
    }
    if (clientFactory) adapterOpts.wsClientFactory = clientFactory
    return createGateioPrivateWsAdapter(adapterOpts)
  },
  sampleOrderRaw: {
    channel: 'futures.orders',
    event: 'update',
    result: [
      {
        id: 'ex-123',
        text: 't-cid-1',
        contract: 'BTC_USDT',
        size: 1,
        price: '30000',
        fill_price: '0',
        left: 1,
        status: 'open',
        is_reduce_only: false,
        create_time: 1.0,
        finish_time: 0,
      },
    ],
  },
  samplePositionRaw: {
    channel: 'futures.positions',
    event: 'update',
    result: [
      {
        contract: 'BTC_USDT',
        size: 1,
        leverage: '4',
        entry_price: '30000',
        unrealised_pnl: '10',
        liq_price: '20000',
        update_time: 1000,
      },
    ],
  },
  sampleBalanceRaw: {
    channel: 'futures.balances',
    event: 'update',
    result: [{ currency: 'USDT', balance: '1000', available: '950', order_margin: '50' }],
  },
})
