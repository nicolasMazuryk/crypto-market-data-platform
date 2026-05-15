import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createEventBus } from '../../core/bus.js'
import { createClock } from '../../core/clock.js'
import { createExecutionLogger } from '../../core/logger.js'
import { MetricsRegistry, registerPrivateWsMetrics } from '../../observability/metrics.js'
import { createPrivateWsAdapterFromSpec } from './private-ws-base.js'
import { createFakeWsClient } from './__tests__/conformance.js'
import type { ParsedWsMessage } from './private-ws-base.js'

function makeMinimalAdapter(exchange: 'binance' | 'bybit') {
  const bus = createEventBus()
  const clock = createClock()
  const logger = createExecutionLogger()
  const registry = new MetricsRegistry()
  const metrics = registerPrivateWsMetrics(registry)
  const fakeClient = createFakeWsClient()

  const adapter = createPrivateWsAdapterFromSpec(
    {
      exchange,
      createClient: () => fakeClient,
      parseMessage: (_raw, receivedAt, seq): ParsedWsMessage => ({
        eventType: 'order',
        orders: [
          {
            exchange,
            seq,
            receivedAt,
            order: {
              clientOrderId: 'cid1',
              symbol: 'BTCUSDT',
              status: 'working',
              side: 'buy',
              type: 'limit',
              qty: 1,
              updatedAt: receivedAt,
            },
          },
        ],
      }),
    },
    { bus, clock, logger, metrics, config: { exchange, enabled: true, credentialsEnvPrefix: '', rateLimits: { criticalReservationFraction: 0.1, criticalWindowSeconds: 1, buckets: [] }, marketRefreshMs: 60000, fundingPullMs: 60000 } }
  )

  return { adapter, fakeClient }
}

describe('private-ws-base seq isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('two adapters have independent seq counters — messages from one do not advance the other', async () => {
    const { adapter: adapterA, fakeClient: clientA } = makeMinimalAdapter('binance')
    const { adapter: adapterB, fakeClient: clientB } = makeMinimalAdapter('bybit')

    const seqsA: number[] = []
    const seqsB: number[] = []
    adapterA.events.on('order', e => seqsA.push(e.seq))
    adapterB.events.on('order', e => seqsB.push(e.seq))

    await adapterA.connect()
    await adapterB.connect()

    clientA.triggerMessage({})
    clientA.triggerMessage({})
    clientA.triggerMessage({})
    clientB.triggerMessage({})

    expect(seqsA).toEqual([1, 2, 3])
    expect(seqsB).toEqual([1])

    await adapterA.disconnect()
    await adapterB.disconnect()
  })
})
