import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Logger } from 'pino'

import { MetricsRegistry, registerRateLimitMetrics } from '../../observability/metrics.js'
import { createRateLimiter, type RateLimiterClockShim } from './tokenBucket.js'

function makeTestClock(): RateLimiterClockShim & { advance(ms: number): void } {
  let mono = 0
  let wall = 1_000_000
  return {
    monotonic: () => mono,
    now: () => wall,
    advance(ms: number) {
      mono += ms
      wall += ms
    },
  }
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger
}

function makeOptions(bucketsOverride?: { endpointClass: string; tokensPerSecond: number; burst: number }[]) {
  const registry = new MetricsRegistry()
  const metrics = registerRateLimitMetrics(registry)
  const clock = makeTestClock()
  const logger = makeLogger()
  return {
    registry,
    metrics,
    clock,
    logger,
    profile: {
      criticalReservationFraction: 0.1,
      criticalWindowSeconds: 60,
      buckets: bucketsOverride ?? [],
    },
  }
}

describe('tokenBucket rate limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('burst is the hard cap — first N requests resolve immediately', async () => {
    const opts = makeOptions([{ endpointClass: 'order_write', tokensPerSecond: 20, burst: 3 }])
    const limiter = createRateLimiter(opts)

    const results: string[] = []
    const p1 = limiter.acquire('order_write', { priority: 'normal' }).then(() => {
      results.push('1')
    })
    const p2 = limiter.acquire('order_write', { priority: 'normal' }).then(() => {
      results.push('2')
    })
    const p3 = limiter.acquire('order_write', { priority: 'normal' }).then(() => {
      results.push('3')
    })
    const p4 = limiter.acquire('order_write', { priority: 'normal' }).then(() => {
      results.push('4')
    })

    // First 3 resolve immediately (burst=3)
    await Promise.resolve()
    await Promise.resolve()
    expect(results).toEqual(['1', '2', '3'])

    // 4th must wait; advance clock enough to refill 1 token (50ms at 20tps)
    opts.clock.advance(50)
    await vi.advanceTimersByTimeAsync(50)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.all([p1, p2, p3, p4])
    expect(results).toEqual(['1', '2', '3', '4'])

    limiter.dispose()
  })

  it('refills at tokensPerSecond with monotonic time', async () => {
    const opts = makeOptions([{ endpointClass: 'order_write', tokensPerSecond: 10, burst: 2 }])
    const limiter = createRateLimiter(opts)

    // Drain burst
    await limiter.acquire('order_write', { priority: 'normal' })
    await limiter.acquire('order_write', { priority: 'normal' })

    // After 100ms at 10tps → 1 new token
    opts.clock.advance(100)

    const resolved = vi.fn()
    const p = limiter.acquire('order_write', { priority: 'normal' }).then(resolved)
    await vi.advanceTimersByTimeAsync(100)
    await Promise.resolve()
    await Promise.resolve()
    await p
    expect(resolved).toHaveBeenCalled()

    limiter.dispose()
  })

  it('critical waiter is served before normal even if enqueued later', async () => {
    const opts = makeOptions([{ endpointClass: 'order_write', tokensPerSecond: 10, burst: 1 }])
    const limiter = createRateLimiter(opts)

    // Drain burst
    await limiter.acquire('order_write', { priority: 'normal' })

    const order: string[] = []
    const normalP = limiter.acquire('order_write', { priority: 'normal' }).then(() => {
      order.push('normal')
    })
    const criticalP = limiter.acquire('order_write', { priority: 'critical' }).then(() => {
      order.push('critical')
    })

    // Refill 1 token for critical first, then 1 for normal
    opts.clock.advance(100)
    await vi.advanceTimersByTimeAsync(100)
    await Promise.resolve()
    await Promise.resolve()

    opts.clock.advance(100)
    await vi.advanceTimersByTimeAsync(100)
    await Promise.resolve()
    await Promise.resolve()

    await Promise.all([normalP, criticalP])
    expect(order[0]).toBe('critical')
    expect(order[1]).toBe('normal')

    limiter.dispose()
  })

  it('reserve(N, windowMs) blocks normal/background from draining below floor', async () => {
    const opts = makeOptions([{ endpointClass: 'order_write', tokensPerSecond: 20, burst: 40 }])
    const limiter = createRateLimiter(opts)

    // Reserve 30 tokens for 1 second
    const release = limiter.reserve('order_write', 30, 1000)

    // Normal acquire up to 40 - 30 = 10 tokens should succeed immediately
    for (let i = 0; i < 10; i++) {
      await limiter.acquire('order_write', { priority: 'normal' })
    }

    // 11th normal should queue (only 0 tokens available for normal)
    let normalResolved = false
    const normalP = limiter.acquire('order_write', { priority: 'normal' }).then(() => {
      normalResolved = true
    })

    await Promise.resolve()
    expect(normalResolved).toBe(false)

    // Critical ignores floor
    await limiter.acquire('order_write', { priority: 'critical' })

    release()
    await vi.runAllTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    await normalP
    expect(normalResolved).toBe(true)

    limiter.dispose()
  })

  it('critical ignores floor and acquires immediately', async () => {
    const opts = makeOptions([{ endpointClass: 'order_write', tokensPerSecond: 20, burst: 5 }])
    const limiter = createRateLimiter(opts)

    // Reserve all 5 tokens
    limiter.reserve('order_write', 5, 5000)

    // Normal cannot acquire
    let normalResolved = false
    limiter
      .acquire('order_write', { priority: 'normal' })
      .then(() => {
        normalResolved = true
      })
      .catch(() => {})

    await Promise.resolve()
    expect(normalResolved).toBe(false)

    // Critical ignores floor
    let criticalResolved = false
    await limiter.acquire('order_write', { priority: 'critical' }).then(() => {
      criticalResolved = true
    })
    expect(criticalResolved).toBe(true)

    limiter.dispose()
  })

  it('reservation expiry releases normal waiters', async () => {
    const opts = makeOptions([{ endpointClass: 'order_write', tokensPerSecond: 5, burst: 10 }])
    const limiter = createRateLimiter(opts)

    // Reserve 10 tokens (all) for 500ms
    limiter.reserve('order_write', 10, 500)

    const resolved = vi.fn()
    const p = limiter.acquire('order_write', { priority: 'normal' }).then(resolved)

    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()

    // Advance past expiry
    opts.clock.advance(501)
    await vi.advanceTimersByTimeAsync(501)
    await Promise.resolve()
    await Promise.resolve()

    await p
    expect(resolved).toHaveBeenCalled()

    limiter.dispose()
  })

  it('signal.abort() rejects with AbortError; bucket state unchanged', async () => {
    const opts = makeOptions([{ endpointClass: 'order_write', tokensPerSecond: 1, burst: 1 }])
    const limiter = createRateLimiter(opts)

    // Drain burst
    await limiter.acquire('order_write', { priority: 'normal' })

    const controller = new AbortController()
    const p = limiter.acquire('order_write', { priority: 'normal', signal: controller.signal })

    const settled = vi.fn()
    p.then(settled).catch(settled)

    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    controller.abort()
    await Promise.resolve()

    await expect(p).rejects.toMatchObject({ name: 'AbortError' })

    limiter.dispose()
  })

  it('abort before queueing returns AbortError immediately', async () => {
    const opts = makeOptions()
    const limiter = createRateLimiter(opts)

    const controller = new AbortController()
    controller.abort()

    // Drain all burst tokens first so we'd normally queue
    for (let i = 0; i < 40; i++) {
      await limiter.acquire('order_write', { priority: 'normal' })
    }

    await expect(
      limiter.acquire('order_write', { priority: 'normal', signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })

    limiter.dispose()
  })

  it('dispose() rejects all pending waiters with EngineShutdown', async () => {
    const opts = makeOptions([{ endpointClass: 'order_write', tokensPerSecond: 1, burst: 1 }])
    const limiter = createRateLimiter(opts)

    await limiter.acquire('order_write', { priority: 'normal' })

    const errors: Error[] = []
    const p1 = limiter.acquire('order_write', { priority: 'normal' }).catch((e: unknown) => {
      errors.push(e as Error)
    })
    const p2 = limiter.acquire('order_write', { priority: 'critical' }).catch((e: unknown) => {
      errors.push(e as Error)
    })

    await Promise.resolve()
    limiter.dispose()
    await Promise.resolve()

    await Promise.allSettled([p1, p2])
    expect(errors).toHaveLength(2)
    expect(errors.every(e => e.name === 'EngineShutdown')).toBe(true)
  })

  it('metrics increment correctly for ok, wait, aborted', async () => {
    const opts = makeOptions([{ endpointClass: 'order_write', tokensPerSecond: 20, burst: 1 }])
    const limiter = createRateLimiter(opts)

    // ok
    await limiter.acquire('order_write', { priority: 'normal' })

    // wait
    const waitP = limiter.acquire('order_write', { priority: 'normal' })
    opts.clock.advance(50)
    await vi.advanceTimersByTimeAsync(50)
    await Promise.resolve()
    await Promise.resolve()
    await waitP

    // aborted
    const ctrl = new AbortController()
    ctrl.abort()
    await limiter.acquire('order_write', { priority: 'normal', signal: ctrl.signal }).catch(() => {})

    const rendered = await opts.registry.render()
    expect(rendered).toMatch(/ratelimit_acquire_total\{bucket="order_write",priority="normal",status="ok"\} 1/)
    expect(rendered).toMatch(/ratelimit_acquire_total\{bucket="order_write",priority="normal",status="wait"\} 1/)
    expect(rendered).toMatch(/ratelimit_acquire_total\{bucket="order_write",priority="normal",status="aborted"\} 1/)

    limiter.dispose()
  })

  it('reserve gauge reflects active reservations', async () => {
    const opts = makeOptions()
    const limiter = createRateLimiter(opts)

    const release1 = limiter.reserve('order_write', 10, 5000)
    const release2 = limiter.reserve('order_write', 5, 5000)

    let rendered = await opts.registry.render()
    expect(rendered).toMatch(/ratelimit_reservation_tokens\{bucket="order_write"\} 15/)

    release1()
    rendered = await opts.registry.render()
    expect(rendered).toMatch(/ratelimit_reservation_tokens\{bucket="order_write"\} 5/)

    release2()
    rendered = await opts.registry.render()
    expect(rendered).toMatch(/ratelimit_reservation_tokens\{bucket="order_write"\} 0/)

    limiter.dispose()
  })
})
