import { describe, expect, it } from 'vitest'
import type { ExchangeConfig } from '../../config/types.js'
import { createEventBus } from '../../core/bus.js'
import { createClock } from '../../core/clock.js'
import { createExecutionLogger } from '../../core/logger.js'
import { MetricsRegistry, registerPrivateWsMetrics } from '../../observability/metrics.js'
import { createGateioPrivateWsAdapter } from './gateio.js'
import { createGateioMessageParser } from './gateio-mapping.js'
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
  createAdapter: clientFactory => {
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
  sampleFundingFeeRaw: {
    channel: 'futures.account_book',
    event: 'update',
    result: [
      {
        contract: 'BTC_USDT',
        change: '-4.5',
        change_type: 'fund',
        time: 1700000.0,
        currency: 'USDT',
      },
    ],
  },
})

describe('GateIO fill synthesis', () => {
  it('synthesizes fill events when filledQty advances across two order updates', () => {
    const parse = createGateioMessageParser()

    const makeUpdate = (left: number, updateTime: number) => ({
      channel: 'futures.orders',
      event: 'update',
      result: [
        {
          id: 'ord-100',
          text: 't-cid-1',
          contract: 'BTC_USDT',
          size: 100,
          price: '50000',
          fill_price: '50000',
          left,
          status: left === 0 ? 'finished' : 'open',
          is_reduce_only: false,
          create_time: 1700000000,
          update_time: updateTime,
        },
      ],
    })

    // left=100 → filledQty=0, no fill emitted
    const r0 = parse(makeUpdate(100, 1700000001), 9999, 1)
    expect(r0.fills).toBeUndefined()

    // left=50 → filledQty=50, fill for delta=50
    const r1 = parse(makeUpdate(50, 1700000002), 9999, 2)
    expect(r1.fills).toHaveLength(1)
    expect(r1.fills![0]!.qty).toBe(50)
    expect(r1.fills![0]!.exchangeFillId).toContain('ord-100')

    // left=0 → filledQty=100, fill for delta=50
    const r2 = parse(makeUpdate(0, 1700000003), 9999, 3)
    expect(r2.fills).toHaveLength(1)
    expect(r2.fills![0]!.qty).toBe(50)

    // Fill IDs must be distinct (different updatedAt)
    expect(r1.fills![0]!.exchangeFillId).not.toBe(r2.fills![0]!.exchangeFillId)
  })
})
