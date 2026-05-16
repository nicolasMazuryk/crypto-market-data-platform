import { describe, expect, it } from 'vitest'
import type { ExchangeConfig } from '../../config/types.js'
import { createEventBus } from '../../core/bus.js'
import { createClock } from '../../core/clock.js'
import { createExecutionLogger } from '../../core/logger.js'
import { MetricsRegistry, registerPrivateWsMetrics } from '../../observability/metrics.js'
import { createOkxPrivateWsAdapter } from './okx.js'
import { parseOkxMessage } from './okx-mapping.js'
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
  createAdapter: clientFactory => {
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
  sampleFundingFeeRaw: {
    arg: { channel: 'account' },
    data: [
      {
        details: [{ ccy: 'USDT', availBal: '9995.5', frozenBal: '0' }],
        bills: [
          {
            bizType: 'FUNDING_FEE',
            instId: 'BTC-USDT-SWAP',
            pnl: '-4.5',
            sz: '0.01',
            ccy: 'USDT',
            ts: '1700000000000',
          },
        ],
      },
    ],
  },
})

describe('OKX fill mapping', () => {
  it('uses accFillSz (cumulative) not fillSz for filledQty', () => {
    const raw = {
      arg: { channel: 'orders', instType: 'SWAP' },
      data: [
        {
          ordId: 'ord-1',
          clOrdId: 'cid-1',
          instId: 'BTC-USDT-SWAP',
          side: 'buy',
          ordType: 'limit',
          sz: '3',
          px: '50000',
          avgPx: '50000',
          state: 'partially_filled',
          fillSz: '1',
          accFillSz: '2',
          tradeId: 'trade-2',
          fillPx: '50000',
          fillFee: '-0.05',
          fillFeeCcy: 'USDT',
          execType: 'T',
          cTime: '1000',
          uTime: '2000',
        },
      ],
    }
    const result = parseOkxMessage(raw, 9999, 1)
    expect(result.orders).toHaveLength(1)
    expect(result.orders![0]!.order.filledQty).toBe(2)
  })

  it('emits three fills with distinct exchangeFillIds for three sequential partial fills', () => {
    const makeOrderEvent = (fillSz: string, accFillSz: string, tradeId: string, uTime: string) => ({
      arg: { channel: 'orders', instType: 'SWAP' },
      data: [
        {
          ordId: 'ord-2',
          clOrdId: 'cid-2',
          instId: 'BTC-USDT-SWAP',
          side: 'sell',
          ordType: 'limit',
          sz: '3',
          state: 'partially_filled',
          fillSz,
          accFillSz,
          tradeId,
          fillPx: '50000',
          fillFee: '-0.01',
          fillFeeCcy: 'USDT',
          execType: 'T',
          cTime: '1000',
          uTime,
        },
      ],
    })
    const r1 = parseOkxMessage(makeOrderEvent('1', '1', 'T1', '2000'), 9999, 1)
    const r2 = parseOkxMessage(makeOrderEvent('1', '2', 'T2', '3000'), 9999, 2)
    const r3 = parseOkxMessage(makeOrderEvent('1', '3', 'T3', '4000'), 9999, 3)

    expect(r1.fills).toHaveLength(1)
    expect(r2.fills).toHaveLength(1)
    expect(r3.fills).toHaveLength(1)

    const ids = [r1.fills![0]!.exchangeFillId, r2.fills![0]!.exchangeFillId, r3.fills![0]!.exchangeFillId]
    expect(new Set(ids).size).toBe(3)
  })
})
