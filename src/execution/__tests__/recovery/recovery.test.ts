import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Logger } from 'pino'
import type { EventBus } from '../../core/types.js'
import type { PersistenceMetrics } from '../../observability/metrics.js'
import type { DrizzleDb } from '../../persistence/db.js'
import type { ExchangeRestAdapter } from '../../adapters/rest/types.js'
import type { Exchange } from '../../types/exchange.js'
import { runRecovery } from '../../recovery/index.js'
import type { EngineConfig } from '../../config/types.js'

function makeMockBus(): EventBus {
  const emitter = new EventEmitter()
  return {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener)
      return () => emitter.off(event, listener)
    },
    off: emitter.off.bind(emitter),
    emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
  } as unknown as EventBus
}

function makeMockMetrics(): PersistenceMetrics {
  return {
    writesTotal: { inc: vi.fn() },
    queueSize: { set: vi.fn(), inc: vi.fn(), dec: vi.fn() },
    droppedTotal: { inc: vi.fn() },
    flushDurationMs: { observe: vi.fn() },
    orphansFlattenedTotal: { inc: vi.fn() },
    orphansCancelledTotal: { inc: vi.fn() },
  } as unknown as PersistenceMetrics
}

function makeMockConfig(): EngineConfig {
  return {
    mode: 'dry_run',
    gitSha: 'test-sha',
    configHash: 'test-hash',
    exchanges: [],
    strategies: [],
    persistence: {
      postgresUrl: '',
      writerQueueSize: 1000,
      walPath: '',
      batchSize: 100,
      flushIntervalMs: 250,
      walMaxBytes: 10 * 1024 * 1024,
    },
    observability: { metricsPort: 9464, tracing: { enabled: false, serviceName: 'test', sampler: 'parent' } },
    risk: { globalMaxConcurrentIntents: 10, globalMaxNotionalUsd: 1000, perStrategy: {} },
    scheduler: { wakeBeforeHourEndMs: 300000, fundingWindowMs: 300000 },
  }
}

function makeRunRow(id: string, endedAt: Date | null = null) {
  return {
    id,
    startedAt: new Date(),
    endedAt,
    mode: 'dry_run' as const,
    configHash: 'hash',
    gitSha: 'sha',
    notes: null,
  }
}

describe('runRecovery', () => {
  let bus: EventBus
  let metrics: PersistenceMetrics

  beforeEach(() => {
    bus = makeMockBus()
    metrics = makeMockMetrics()
    vi.clearAllMocks()
  })

  it('creates a new run when no open run exists', async () => {
    const insertedRuns: unknown[] = []
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation((row: unknown) => {
            insertedRuns.push(row)
            return Promise.resolve([makeRunRow('new-run-id')])
          }),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    } as unknown as DrizzleDb

    const restAdapters = new Map<Exchange, ExchangeRestAdapter>()

    const result = await runRecovery({
      db,
      config: makeMockConfig(),
      bus,
      restAdapters,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        childFor: () => ({}),
      } as unknown as Logger,
      metrics,
    })

    expect(result.runId).toBeDefined()
    expect(result.rehydratedCount).toBe(0)
    expect(result.orphansCancelled).toBe(0)
    expect(result.orphansFlattened).toBe(0)
    expect(result.initialState.intentStates.size).toBe(0)
  })

  it('cancels orphan REST orders not in persisted state', async () => {
    const cancelOrder = vi.fn().mockResolvedValue(undefined)
    const mockRest: Partial<ExchangeRestAdapter> = {
      getOpenOrders: vi.fn().mockResolvedValue([
        {
          exchange: 'binance',
          symbol: 'BTCUSDT',
          clientOrderId: 'orphan-order-id',
          exchangeOrderId: 'exchange-123',
          side: 'buy',
          type: 'market',
          qty: 0.001,
          filledQty: 0,
          reduceOnly: false,
          status: 'new',
          submittedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      getPositions: vi.fn().mockResolvedValue([]),
      cancelOrder,
    }

    const restAdapters = new Map<Exchange, ExchangeRestAdapter>([['binance', mockRest as ExchangeRestAdapter]])

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([makeRunRow('run-123')]),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    } as unknown as DrizzleDb

    const result = await runRecovery({
      db,
      config: makeMockConfig(),
      bus,
      restAdapters,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        childFor: () => ({}),
      } as unknown as Logger,
      metrics,
    })

    expect(cancelOrder).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      clientOrderId: 'orphan-order-id',
    })
    expect(result.orphansCancelled).toBe(1)
    expect(metrics.orphansCancelledTotal.inc).toHaveBeenCalledWith(1, { exchange: 'binance' })
  })

  it('flattens orphan REST positions not in persisted state', async () => {
    const createOrder = vi.fn().mockResolvedValue({ status: 'new' })
    const mockRest: Partial<ExchangeRestAdapter> = {
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getPositions: vi.fn().mockResolvedValue([
        {
          exchange: 'binance',
          symbol: 'ETHUSDT',
          qty: 0.1,
          side: 'long',
          leverage: 5,
          updatedAt: Date.now(),
        },
      ]),
      createOrder,
    }

    const restAdapters = new Map<Exchange, ExchangeRestAdapter>([['binance', mockRest as ExchangeRestAdapter]])

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([makeRunRow('run-456')]),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    } as unknown as DrizzleDb

    const result = await runRecovery({
      db,
      config: makeMockConfig(),
      bus,
      restAdapters,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        childFor: () => ({}),
      } as unknown as Logger,
      metrics,
    })

    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'sell',
        type: 'market',
        qty: 0.1,
        reduceOnly: true,
        symbol: 'ETHUSDT',
      })
    )
    expect(result.orphansFlattened).toBe(1)
    expect(metrics.orphansFlattenedTotal.inc).toHaveBeenCalledWith(1, { exchange: 'binance' })
  })
})
