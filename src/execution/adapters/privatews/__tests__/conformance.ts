import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ExchangePrivateWsAdapter } from '../types.js'
import type { PrivateWsClient } from '../private-ws-base.js'
import { makeTypedEmitter } from '../binance-client.js'
import type { PrivateWsClientEvents } from '../private-ws-base.js'
import type { Exchange } from '../../../types/exchange.js'
import { MetricsRegistry, registerPrivateWsMetrics } from '../../../observability/metrics.js'
import { createEventBus } from '../../../core/bus.js'
import { createClock } from '../../../core/clock.js'
import { createExecutionLogger } from '../../../core/logger.js'

export interface FakeWsClient extends PrivateWsClient {
  triggerClose(reason?: string): void
  triggerError(err?: Error): void
  triggerMessage(raw: unknown): void
  triggerAuthExpired(): void
}

export function createFakeWsClient(): FakeWsClient {
  const ev = makeTypedEmitter<PrivateWsClientEvents>()
  return {
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    disconnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    events: ev,
    triggerClose: (reason = 'test close') => {
      ev.emit('close', reason)
    },
    triggerError: (err = new Error('test error')) => {
      ev.emit('error', err)
    },
    triggerMessage: (raw: unknown) => {
      ev.emit('message', raw)
    },
    triggerAuthExpired: () => {
      ev.emit('authExpired')
    },
  }
}

export interface WsConformanceFixtures {
  exchange: Exchange
  createAdapter(clientFactory?: () => PrivateWsClient): ExchangePrivateWsAdapter
  sampleOrderRaw: unknown
  samplePositionRaw: unknown
  sampleBalanceRaw: unknown
  /** Raw WS message that should trigger a fundingFee adapter event. Optional — skipped if absent. */
  sampleFundingFeeRaw?: unknown
}

export function runWsAdapterConformance(fixtures: WsConformanceFixtures): void {
  describe(`${fixtures.exchange} WS conformance`, () => {
    let fakeClient: FakeWsClient
    let adapter: ExchangePrivateWsAdapter
    const bus = createEventBus()
    const clock = createClock()
    const logger = createExecutionLogger()
    const registry = new MetricsRegistry()
    const metrics = registerPrivateWsMetrics(registry)

    beforeEach(() => {
      vi.useFakeTimers()
      fakeClient = createFakeWsClient()
      adapter = fixtures.createAdapter(() => fakeClient)
    })

    afterEach(async () => {
      await adapter.disconnect().catch(() => undefined)
      vi.restoreAllMocks()
      vi.useRealTimers()
    })

    // Suppress unused variable warnings — bus/clock/logger/registry/metrics are used by createAdapter closures
    void bus
    void clock
    void logger
    void registry
    void metrics

    it('emits order event when order message received', async () => {
      const orders: unknown[] = []
      adapter.events.on('order', e => orders.push(e))
      await adapter.connect()
      fakeClient.triggerMessage(fixtures.sampleOrderRaw)
      expect(orders).toHaveLength(1)
    })

    it('emits position event when position message received', async () => {
      const positions: unknown[] = []
      adapter.events.on('position', e => positions.push(e))
      await adapter.connect()
      fakeClient.triggerMessage(fixtures.samplePositionRaw)
      expect(positions).toHaveLength(1)
    })

    it('emits balance event when balance message received', async () => {
      const balances: unknown[] = []
      adapter.events.on('balance', e => balances.push(e))
      await adapter.connect()
      fakeClient.triggerMessage(fixtures.sampleBalanceRaw)
      expect(balances).toHaveLength(1)
    })

    it('assigns incrementing seq numbers across messages', async () => {
      const seqs: number[] = []
      adapter.events.on('order', e => seqs.push(e.seq))
      await adapter.connect()
      for (let i = 0; i < 3; i++) fakeClient.triggerMessage(fixtures.sampleOrderRaw)
      expect(seqs).toEqual([1, 2, 3])
    })

    it('transitions connecting → connected → reconnecting after close', async () => {
      const states: string[] = []
      adapter.events.on('connectionState', e => states.push(e.state))
      await adapter.connect()
      fakeClient.triggerClose('drop')
      await vi.runAllTimersAsync()
      expect(states).toContain('connecting')
      expect(states).toContain('connected')
      expect(states).toContain('reconnecting')
    })

    it('disconnect() cancels pending reconnect', async () => {
      await adapter.connect()
      fakeClient.triggerClose('drop')
      await adapter.disconnect()
      await vi.runAllTimersAsync()
      // After disconnect, no further connects should occur (connect mock called only once for initial)
      const connectCalls = (fakeClient.connect as ReturnType<typeof vi.fn>).mock.calls.length
      expect(connectCalls).toBe(1)
    })

    if (fixtures.sampleFundingFeeRaw !== undefined) {
      it('emits fundingFee event with valid fields when funding-fee message received', async () => {
        const fees: unknown[] = []
        adapter.events.on('fundingFee', e => fees.push(e))
        await adapter.connect()
        fakeClient.triggerMessage(fixtures.sampleFundingFeeRaw)
        expect(fees).toHaveLength(1)
        const fee = fees[0] as {
          exchange: unknown
          symbol: string
          fundingTime: number
          fundingAmount: number
          receivedAt: unknown
        }
        // Required fields must be present and non-NaN
        expect(typeof fee.exchange).toBe('string')
        expect(typeof fee.symbol).toBe('string')
        expect(fee.symbol.length).toBeGreaterThan(0)
        expect(typeof fee.fundingTime).toBe('number')
        expect(isNaN(fee.fundingTime)).toBe(false)
        expect(typeof fee.fundingAmount).toBe('number')
        expect(isNaN(fee.fundingAmount)).toBe(false)
        expect(typeof fee.receivedAt).toBe('number')
      })
    }
  })
}
