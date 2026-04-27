import { performance } from 'node:perf_hooks'

import type { Logger } from 'pino'

import type { RateLimitProfile } from '../../config/types.js'
import type { RateLimitMetrics } from '../../observability/metrics.js'
import type { Unsubscribe } from '../../types/exchange.js'
import type { RateLimiter, RateLimiterAcquireOptions, RateLimitPriority } from '../types.js'

const DEFAULTS: Record<string, { tokensPerSecond: number; burst: number }> = {
  order_write: { tokensPerSecond: 20, burst: 40 },
  order_read: { tokensPerSecond: 20, burst: 40 },
  account_read: { tokensPerSecond: 10, burst: 20 },
  time: { tokensPerSecond: 5, burst: 10 },
}

interface Reservation {
  tokensFloor: number
  expiresAt: number
}

interface Waiter {
  priority: RateLimitPriority
  tokens: number
  resolve: () => void
  reject: (err: Error) => void
  signal?: AbortSignal
  abortListener?: () => void
}

interface Bucket {
  tokensPerSecond: number
  burst: number
  tokens: number
  lastRefillMono: number
  queues: Record<RateLimitPriority, Waiter[]>
  reservations: Reservation[]
  timer: ReturnType<typeof setTimeout> | null
}

export interface RateLimiterClockShim {
  monotonic(): number
  now(): number
}

export interface RateLimiterOptions {
  profile: RateLimitProfile
  clock?: RateLimiterClockShim
  metrics: RateLimitMetrics
  logger: Logger
}

const PRIORITY_ORDER: RateLimitPriority[] = ['critical', 'normal', 'background']

export function createRateLimiter(options: RateLimiterOptions): RateLimiter & { dispose(): void } {
  const { metrics, logger } = options
  const clock: RateLimiterClockShim = options.clock ?? {
    monotonic: () => performance.now(),
    now: () => Date.now(),
  }

  const buckets = new Map<string, Bucket>()
  let disposed = false

  function initBucket(cls: string): Bucket {
    const override = options.profile.buckets.find(b => b.endpointClass === cls)
    const def = DEFAULTS[cls] ?? { tokensPerSecond: 10, burst: 20 }
    const cfg = override ?? def
    return {
      tokensPerSecond: cfg.tokensPerSecond,
      burst: cfg.burst,
      tokens: cfg.burst,
      lastRefillMono: clock.monotonic(),
      queues: { critical: [], normal: [], background: [] },
      reservations: [],
      timer: null,
    }
  }

  const classNames = new Set([...Object.keys(DEFAULTS), ...options.profile.buckets.map(b => b.endpointClass)])
  for (const cls of classNames) {
    buckets.set(cls, initBucket(cls))
  }

  function getBucket(cls: string): Bucket {
    let b = buckets.get(cls)
    if (!b) {
      b = initBucket(cls)
      buckets.set(cls, b)
    }
    return b
  }

  function refill(b: Bucket): void {
    const now = clock.monotonic()
    const elapsed = now - b.lastRefillMono
    b.tokens = Math.min(b.burst, b.tokens + (elapsed * b.tokensPerSecond) / 1000)
    b.lastRefillMono = now
  }

  function computeFloor(b: Bucket): number {
    const wallNow = clock.now()
    b.reservations = b.reservations.filter(r => r.expiresAt > wallNow)
    return b.reservations.reduce((sum, r) => sum + r.tokensFloor, 0)
  }

  function getAvailable(b: Bucket, priority: RateLimitPriority): number {
    if (priority === 'critical') return b.tokens
    return Math.max(0, b.tokens - computeFloor(b))
  }

  function drain(cls: string, b: Bucket): void {
    b.timer = null
    if (disposed) return

    refill(b)

    for (const p of PRIORITY_ORDER) {
      const q = b.queues[p]
      while (q.length > 0) {
        const w = q[0]
        if (w === undefined) break
        if (getAvailable(b, p) >= w.tokens) {
          q.shift()
          b.tokens -= w.tokens
          if (w.abortListener && w.signal) {
            w.signal.removeEventListener('abort', w.abortListener)
          }
          w.resolve()
        } else {
          break
        }
      }
    }

    scheduleNext(cls, b)
  }

  function scheduleNext(cls: string, b: Bucket): void {
    if (b.timer !== null) return

    let nextWaiter: Waiter | undefined
    let nextPriority: RateLimitPriority | undefined
    for (const p of PRIORITY_ORDER) {
      if (b.queues[p].length > 0) {
        nextWaiter = b.queues[p][0]
        nextPriority = p
        break
      }
    }
    if (!nextWaiter || !nextPriority) return

    refill(b)
    const avail = getAvailable(b, nextPriority)
    if (avail >= nextWaiter.tokens) {
      b.timer = setTimeout(() => {
        drain(cls, b)
      }, 0)
      return
    }

    const deficit = nextWaiter.tokens - avail
    const refillMs = Math.ceil((deficit / b.tokensPerSecond) * 1000)

    let waitMs = refillMs
    if (nextPriority !== 'critical' && b.reservations.length > 0) {
      const wallNow = clock.now()
      const nextExpiry = Math.min(...b.reservations.map(r => r.expiresAt))
      const expiryIn = Math.max(1, nextExpiry - wallNow + 1)
      waitMs = Math.min(refillMs, expiryIn)
    }

    b.timer = setTimeout(() => {
      drain(cls, b)
    }, waitMs)
  }

  return {
    acquire(cls: string, opts: RateLimiterAcquireOptions): Promise<void> {
      if (disposed) return Promise.reject(new Error('RateLimiter disposed'))

      const { priority, tokens = 1, signal } = opts
      const b = getBucket(cls)

      if (signal?.aborted) {
        metrics.acquireTotal.inc(1, { bucket: cls, priority, status: 'aborted' })
        return Promise.reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }))
      }

      refill(b)
      if (getAvailable(b, priority) >= tokens) {
        b.tokens -= tokens
        metrics.acquireTotal.inc(1, { bucket: cls, priority, status: 'ok' })
        metrics.tokensAvailable.set(b.tokens, { bucket: cls })
        return Promise.resolve()
      }

      const waitStart = clock.now()
      return new Promise<void>((resolve, reject) => {
        const w: Waiter = {
          priority,
          tokens,
          resolve: () => {
            const ms = clock.now() - waitStart
            metrics.acquireTotal.inc(1, { bucket: cls, priority, status: 'wait' })
            metrics.waitDurationMs.observe(ms, { bucket: cls, priority })
            resolve()
          },
          reject,
        }
        if (signal !== undefined) w.signal = signal

        if (signal) {
          const handler = () => {
            const q = b.queues[priority]
            const idx = q.indexOf(w)
            if (idx !== -1) q.splice(idx, 1)
            metrics.acquireTotal.inc(1, { bucket: cls, priority, status: 'aborted' })
            reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }))
          }
          w.abortListener = handler
          signal.addEventListener('abort', handler, { once: true })
        }

        b.queues[priority].push(w)
        scheduleNext(cls, b)
      })
    },

    reserve(cls: string, tokens: number, windowMs: number): Unsubscribe {
      const b = getBucket(cls)
      const expiresAt = clock.now() + windowMs
      const res: Reservation = { tokensFloor: tokens, expiresAt }
      b.reservations.push(res)

      const updateGauge = () => {
        const wallNow = clock.now()
        const total = b.reservations.filter(r => r.expiresAt > wallNow).reduce((s, r) => s + r.tokensFloor, 0)
        metrics.reservationTokens.set(total, { bucket: cls })
      }
      updateGauge()
      scheduleNext(cls, b)

      return () => {
        const idx = b.reservations.indexOf(res)
        if (idx !== -1) b.reservations.splice(idx, 1)
        updateGauge()
        if (b.timer === null) drain(cls, b)
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      const err = Object.assign(new Error('EngineShutdown'), { name: 'EngineShutdown' })
      for (const b of buckets.values()) {
        if (b.timer !== null) {
          clearTimeout(b.timer)
          b.timer = null
        }
        for (const p of PRIORITY_ORDER) {
          for (const w of b.queues[p]) {
            if (w.abortListener && w.signal) {
              w.signal.removeEventListener('abort', w.abortListener)
            }
            w.reject(err)
          }
          b.queues[p] = []
        }
      }
      logger.debug({ event: 'ratelimiter.disposed' }, 'rate limiter disposed')
    },
  }
}
