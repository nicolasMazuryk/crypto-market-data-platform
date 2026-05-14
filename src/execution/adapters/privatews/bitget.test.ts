import type { ExchangeConfig } from '../../config/types.js'
import { createEventBus } from '../../core/bus.js'
import { createClock } from '../../core/clock.js'
import { createExecutionLogger } from '../../core/logger.js'
import { MetricsRegistry, registerPrivateWsMetrics } from '../../observability/metrics.js'
import { createBitgetPrivateWsAdapter } from './bitget.js'
import { runWsAdapterConformance } from './__tests__/conformance.js'

function makeConfig(): ExchangeConfig {
  return {
    exchange: 'bitget',
    enabled: true,
    credentialsEnvPrefix: 'BITGET',
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
  exchange: 'bitget',
  createAdapter: clientFactory => {
    const adapterOpts: Parameters<typeof createBitgetPrivateWsAdapter>[0] = {
      config: makeConfig(),
      bus,
      clock,
      logger,
      metrics,
    }
    if (clientFactory) adapterOpts.wsClientFactory = clientFactory
    return createBitgetPrivateWsAdapter(adapterOpts)
  },
  sampleOrderRaw: {
    arg: { channel: 'orders', instType: 'USDT-FUTURES' },
    data: [
      {
        orderId: 'ex-123',
        clientOid: 'cid-1',
        instId: 'BTCUSDT',
        side: 'buy',
        orderType: 'limit',
        size: '0.001',
        price: '30000',
        avgPx: '0',
        status: 'new',
        accBaseVolume: '0',
        reduceOnly: 'no',
        cTime: '1000',
        uTime: '1000',
      },
    ],
  },
  samplePositionRaw: {
    arg: { channel: 'positions', instType: 'USDT-FUTURES' },
    data: [
      {
        instId: 'BTCUSDT',
        posSide: 'long',
        pos: '0.001',
        avgPx: '30000',
        upl: '10',
        lever: '4',
        liqPx: '20000',
        uTime: '1000',
      },
    ],
  },
  sampleBalanceRaw: {
    arg: { channel: 'account', instType: 'USDT-FUTURES' },
    data: [{ coinName: 'USDT', available: '1000', frozen: '50', uTime: '1000' }],
  },
  sampleFundingFeeRaw: {
    action: 'snapshot',
    arg: { channel: 'account', instType: 'USDT-FUTURES' },
    data: [
      {
        instId: 'BTCUSDT',
        bizType: 'fund',
        amount: '-4.5',
        uTime: '1700000000000',
      },
    ],
  },
})
