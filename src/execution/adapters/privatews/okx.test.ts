import type { ExchangeConfig } from '../../config/types.js'
import { createEventBus } from '../../core/bus.js'
import { createClock } from '../../core/clock.js'
import { createExecutionLogger } from '../../core/logger.js'
import { MetricsRegistry, registerPrivateWsMetrics } from '../../observability/metrics.js'
import { createOkxPrivateWsAdapter } from './okx.js'
import { runWsAdapterConformance } from './__tests__/conformance.js'

function makeConfig(): ExchangeConfig {
  return {
    exchange: 'okx',
    enabled: true,
    credentialsEnvPrefix: 'OKX',
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
  exchange: 'okx',
  createAdapter: (clientFactory) => {
    const adapterOpts: Parameters<typeof createOkxPrivateWsAdapter>[0] = {
      config: makeConfig(),
      bus,
      clock,
      logger,
      metrics,
    }
    if (clientFactory) adapterOpts.wsClientFactory = clientFactory
    return createOkxPrivateWsAdapter(adapterOpts)
  },
  sampleOrderRaw: {
    arg: { channel: 'orders', instType: 'SWAP' },
    data: [
      {
        ordId: 'ex-123',
        clOrdId: 'cid-1',
        instId: 'BTC-USDT-SWAP',
        side: 'buy',
        ordType: 'limit',
        sz: '0.001',
        px: '30000',
        avgPx: '',
        state: 'live',
        fillSz: '0',
        reduceOnly: false,
        cTime: '1000',
        uTime: '1000',
      },
    ],
  },
  samplePositionRaw: {
    arg: { channel: 'positions', instType: 'SWAP' },
    data: [
      {
        instId: 'BTC-USDT-SWAP',
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
    arg: { channel: 'account' },
    data: [{ details: [{ ccy: 'USDT', availBal: '1000', frozenBal: '50' }] }],
  },
})
