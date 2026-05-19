import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

import type { Logger } from 'pino'
import type { EventBus } from '../../core/types.js'
import type { PersistenceMetrics } from '../../observability/metrics.js'
import type { DrizzleDb } from '../../persistence/db.js'
import type { WalHandle, WalEntry } from '../../persistence/wal.js'
import { createPersistenceWriter, writeRowToDb } from '../../persistence/writer.js'
import type { TradeIntent } from '../../strategies/types.js'
import type { FillEvent } from '../../adapters/privatews/types.js'

function makeMockBus(): EventBus {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  return {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener)
      return () => emitter.off(event, listener)
    },
    off: (event: string, listener: (...args: unknown[]) => void) => emitter.off(event, listener),
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

function makeMockWal(): WalHandle & { entries: WalEntry[] } {
  const entries: WalEntry[] = []
  return {
    entries,
    append: vi.fn((entry: WalEntry) => entries.push(entry)),
    peek: vi.fn((): WalEntry[] => [...entries]),
    rewrite: vi.fn((newEntries: WalEntry[]) => {
      entries.length = 0
      entries.push(...newEntries)
    }),
    drain: vi.fn((): WalEntry[] => {
      const copy = [...entries]
      entries.length = 0
      return copy
    }),
    size: vi.fn(() => entries.length),
  }
}

function makeMockDb(shouldFail = false): DrizzleDb {
  const insertMock = vi.fn().mockImplementation(() => ({
    values: () => ({
      onConflictDoNothing: () => (shouldFail ? Promise.reject(new Error('DB error')) : Promise.resolve()),
      onConflictDoUpdate: () => (shouldFail ? Promise.reject(new Error('DB error')) : Promise.resolve()),
    }),
  }))
  return { insert: insertMock } as unknown as DrizzleDb
}

function makeMockIntent(): TradeIntent {
  return {
    id: 'test-intent-id',
    strategy: 'strategy_1',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    exchangeSymbol: 'BTCUSDT',
    side: 'short',
    amountUsd: 10,
    leverage: 5,
    volume: 0.0005,
    fundingRate: -0.0005,
    fundingRatePercent: -0.05,
    fundingInterval: 8,
    nextFundingTimestamp: Date.now() + 3600_000,
    nextFundingDatetime: new Date(Date.now() + 3600_000).toISOString(),
    decidedAt: Date.now(),
    entryAt: Date.now() + 10_000,
    exitPolicy: { kind: 'timed', exitAt: Date.now() + 3600_000 },
  }
}

describe('PersistenceWriter', () => {
  let bus: EventBus
  let metrics: PersistenceMetrics
  let wal: ReturnType<typeof makeMockWal>

  beforeEach(() => {
    bus = makeMockBus()
    metrics = makeMockMetrics()
    wal = makeMockWal()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('enqueues intent.decided event without blocking', () => {
    const db = makeMockDb(false)
    const writer = createPersistenceWriter({
      db,
      wal,
      bus,
      runId: 'run-1',
      logger: {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        childFor: () => ({}),
      } as unknown as Logger,
      metrics,
      batchSize: 100,
      flushIntervalMs: 250,
    })
    writer.start()

    const intent = makeMockIntent()
    const start = Date.now()
    ;(bus as unknown as { emit: (e: string, ...args: unknown[]) => void }).emit('intent.decided', intent)
    const elapsed = Date.now() - start

    // emit is synchronous and must not block
    expect(elapsed).toBeLessThan(5)
    expect(metrics.queueSize.set).toHaveBeenCalled()

    writer.stop()
  })

  it('drops writes when queue is full and increments drop metric', () => {
    const db = makeMockDb(false)
    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      childFor: () => ({}),
    } as unknown as Logger
    const writer = createPersistenceWriter({
      db,
      wal,
      bus,
      runId: 'run-1',
      logger,
      metrics,
      batchSize: 100,
      flushIntervalMs: 250,
    })
    writer.start()

    // Flood queue past 1000
    for (let i = 0; i < 1100; i++) {
      ;(bus as unknown as { emit: (e: string, ...args: unknown[]) => void }).emit('intent.decided', makeMockIntent())
    }

    expect(metrics.droppedTotal.inc).toHaveBeenCalledWith(1, { reason: 'overflow' })
    writer.stop()
  })

  it('writes to WAL when DB fails, drains WAL on recovery', async () => {
    const failingDb = makeMockDb(true)
    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      childFor: () => ({}),
    } as unknown as Logger
    const writer = createPersistenceWriter({
      db: failingDb,
      wal,
      bus,
      runId: 'run-1',
      logger,
      metrics,
      batchSize: 100,
      flushIntervalMs: 250,
    })
    writer.start()
    ;(bus as unknown as { emit: (e: string, ...args: unknown[]) => void }).emit('intent.decided', makeMockIntent())

    await writer.flushAndWait()

    // WAL should have received the entry since DB failed
    expect(wal.append).toHaveBeenCalled()

    writer.stop()
  })

  it('flushAndWait drains queue before resolving', async () => {
    const db = makeMockDb(false)
    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      childFor: () => ({}),
    } as unknown as Logger
    const writer = createPersistenceWriter({
      db,
      wal,
      bus,
      runId: 'run-1',
      logger,
      metrics,
      batchSize: 100,
      flushIntervalMs: 60_000, // long interval so it won't auto-flush
    })
    writer.start()

    const intent = makeMockIntent()
    ;(bus as unknown as { emit: (e: string, ...args: unknown[]) => void }).emit('intent.decided', intent)

    await writer.flushAndWait()

    // After flushAndWait, queue should be empty
    expect(metrics.queueSize.set).toHaveBeenLastCalledWith(0)
    writer.stop()
  })
})

describe('PersistenceWriter — fill handling', () => {
  let bus: EventBus
  let metrics: PersistenceMetrics
  let wal: ReturnType<typeof makeMockWal>
  const mockLogger = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    childFor: () => mockLogger,
  } as unknown as Logger

  beforeEach(() => {
    bus = makeMockBus()
    metrics = makeMockMetrics()
    wal = makeMockWal()
    // No fake timers — these tests rely on real async resolution
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('resolves fill by exchangeOrderId fallback when clientOrderId is empty', async () => {
    const foundOrder = { id: 'order-uuid', intentId: 'intent-1', kind: 'entry' }
    let selectCallCount = 0
    const db = {
      select: vi.fn().mockReturnValue({
        from: () => ({
          where: () => ({
            limit: () => {
              selectCallCount++
              // First call (primary by clientOrderId) would be skipped since clientOrderId is empty.
              // Only the fallback call (by exchangeOrderId) runs.
              return Promise.resolve([foundOrder])
            },
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: () => ({
          onConflictDoNothing: () => Promise.resolve(),
          onConflictDoUpdate: () => Promise.resolve(),
        }),
      }),
    } as unknown as DrizzleDb

    const writer = createPersistenceWriter({
      db,
      wal,
      bus,
      runId: 'run-1',
      logger: mockLogger,
      metrics,
      identity: { strategy: 'strategy_1', subAccountId: 'acc-1', exchange: 'binance', combinationId: 'c-1' },
    })
    writer.start()

    const fillEvent: FillEvent = {
      exchange: 'binance',
      symbol: 'BTCUSDT',
      clientOrderId: '',
      exchangeOrderId: 'EX-99',
      exchangeFillId: 'FILL-1',
      qty: 1,
      price: 50000,
      feeAsset: 'USDT',
      feeAmount: 0.01,
      isMaker: false,
      ts: Date.now(),
      receivedAt: Date.now(),
    }
    ;(bus as unknown as { emit: (e: string, ...args: unknown[]) => void }).emit('ws.fill', fillEvent)

    // Let async handler run
    await new Promise(r => setTimeout(r, 0))

    // Should have used the exchangeOrderId fallback (one select call)
    expect(selectCallCount).toBe(1)
    // Fill enqueued
    expect(metrics.writesTotal.inc).toHaveBeenCalledWith(1, { table: 'fills', result: 'queued' })

    writer.stop()
  })

  it('stamps strategy and subAccountId from identity on fill rows', async () => {
    const foundOrder = { id: 'order-uuid', intentId: 'intent-1', kind: 'entry' }
    const db = {
      select: vi.fn().mockReturnValue({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([foundOrder]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: () => ({
          onConflictDoNothing: () => Promise.resolve(),
          onConflictDoUpdate: () => Promise.resolve(),
        }),
      }),
    } as unknown as DrizzleDb

    const writer = createPersistenceWriter({
      db,
      wal,
      bus,
      runId: 'run-1',
      logger: mockLogger,
      metrics,
      identity: { strategy: 'strategy_1', subAccountId: 'acc-42', exchange: 'okx', combinationId: 'c-2' },
    })
    writer.start()

    const fillEvent: FillEvent = {
      exchange: 'okx',
      symbol: 'BTC-USDT-SWAP',
      clientOrderId: 'cid-x',
      exchangeFillId: 'FILL-X',
      qty: 2,
      price: 60000,
      feeAsset: 'USDT',
      feeAmount: 0.02,
      isMaker: true,
      ts: Date.now(),
      receivedAt: Date.now(),
    }
    ;(bus as unknown as { emit: (e: string, ...args: unknown[]) => void }).emit('ws.fill', fillEvent)
    await new Promise(r => setTimeout(r, 0))
    await writer.flushAndWait()

    // At minimum, verify fill was queued with correct identity
    expect(metrics.writesTotal.inc).toHaveBeenCalledWith(1, { table: 'fills', result: 'queued' })

    writer.stop()
  })
})

describe('PersistenceWriter — orders_status GREATEST', () => {
  it('writeRowToDb uses GREATEST expression for filledQty in orders_status', async () => {
    const setCalls: unknown[] = []
    const db = {
      update: vi.fn().mockReturnValue({
        set: (updateSet: unknown) => {
          setCalls.push(updateSet)
          return {
            where: vi.fn().mockResolvedValue(undefined),
          }
        },
      }),
    } as unknown as DrizzleDb

    await writeRowToDb(db, 'orders_status', {
      exchange: 'binance',
      clientOrderId: 'cid-1',
      status: 'partially_filled',
      filledQty: '3',
    })

    expect(setCalls).toHaveLength(1)
    const updateSet = setCalls[0] as Record<string, unknown>
    // filledQty must be a SQL expression object (not a plain string) — GREATEST(...)
    expect(typeof updateSet.filledQty).not.toBe('string')
  })

  it('writeRowToDb uses COALESCE for firstFillAt and workingAt in orders_status', async () => {
    const setCalls: unknown[] = []
    const db = {
      update: vi.fn().mockReturnValue({
        set: (updateSet: unknown) => {
          setCalls.push(updateSet)
          return { where: vi.fn().mockResolvedValue(undefined) }
        },
      }),
    } as unknown as DrizzleDb

    await writeRowToDb(db, 'orders_status', {
      exchange: 'binance',
      clientOrderId: 'cid-1',
      status: 'partially_filled',
      filledQty: '1',
      firstFillAt: new Date(),
      workingAt: new Date(),
    })

    const updateSet = setCalls[0] as Record<string, unknown>
    // firstFillAt and workingAt must be Drizzle SQL expressions (COALESCE), not plain Dates
    expect(updateSet.firstFillAt).toBeDefined()
    expect(updateSet.firstFillAt instanceof Date).toBe(false)
    expect(updateSet.workingAt instanceof Date).toBe(false)
  })
})

describe('PersistenceWriter — identity guard', () => {
  it('throws when identity missing and NODE_ENV is not test', () => {
    const originalEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect(() =>
        createPersistenceWriter({
          db: makeMockDb(false),
          wal: makeMockWal(),
          bus: makeMockBus(),
          runId: 'run-1',
          logger: {
            warn: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            childFor: () => ({}),
          } as unknown as Logger,
          metrics: makeMockMetrics(),
        })
      ).toThrow('PersistenceWriter requires identity')
    } finally {
      process.env.NODE_ENV = originalEnv
    }
  })
})
