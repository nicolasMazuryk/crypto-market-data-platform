import type { RateLimiter, RateLimiterAcquireOptions, RateLimitPriority } from '../../core/types.js'
import type { Exchange } from '../../types/exchange.js'
import type { RestMetrics } from '../../observability/metrics.js'

export type EndpointClass = 'order_write' | 'order_read' | 'account_read' | 'time'

export interface MappedError {
  code: string
  message: string
  isRetryable: boolean
  isReject: boolean
}

export async function withRateLimit<T>(
  limiter: RateLimiter,
  cls: EndpointClass,
  priority: RateLimitPriority,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const opts: RateLimiterAcquireOptions = { priority }
  if (signal !== undefined) opts.signal = signal
  await limiter.acquire(cls, opts)
  return fn()
}

export async function withMetrics<T>(
  metrics: RestMetrics,
  exchange: Exchange,
  method: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now()
  try {
    const result = await fn()
    metrics.requestTotal.inc(1, { exchange, method, status: 'ok' })
    metrics.requestDurationMs.observe(Date.now() - start, { exchange, method })
    return result
  } catch (err) {
    metrics.requestTotal.inc(1, { exchange, method, status: 'error' })
    metrics.requestDurationMs.observe(Date.now() - start, { exchange, method })
    throw err
  }
}

const RETRYABLE_NAMES = new Set(['NetworkError', 'RequestTimeout', 'DDoSProtection', 'ExchangeNotAvailable'])
const REJECT_NAMES = new Set([
  'ExchangeError',
  'OrderNotFound',
  'InsufficientFunds',
  'InvalidOrder',
  'AuthenticationError',
  'PermissionDenied',
  'BadRequest',
  'BadResponse',
  'BadSymbol',
  'MarginModeAlreadySet',
  'OnMaintenance',
])

export function mapCcxtError(err: unknown): MappedError {
  if (!(err instanceof Error)) {
    return { code: 'unknown', message: String(err), isRetryable: false, isReject: false }
  }

  const name = err.name

  if (RETRYABLE_NAMES.has(name)) {
    return { code: name, message: err.message, isRetryable: true, isReject: false }
  }

  if (name === 'OrderNotFound') {
    return { code: 'OrderNotFound', message: err.message, isRetryable: false, isReject: true }
  }

  if (REJECT_NAMES.has(name)) {
    // Try error.code property first (some CCXT errors carry numeric code)
    const errWithCode = err as { code?: number | string }
    const codeFromProp = errWithCode.code !== undefined ? String(errWithCode.code) : undefined
    // Extract from message: negative number (Binance: -4116), positive 4+ digit (Bitget: 40762, Bybit: 110071),
    // or SCREAMING_SNAKE_CASE label (Gate.io: TEXT_DUPLICATED, KuCoin: ORDER_ALREADY_EXISTS)
    const codeMatch =
      /(-\d+)/.exec(err.message) ??
      /\b(\d{4,})\b/.exec(err.message) ??
      /\b([A-Z]{2,}(?:_[A-Z]{2,})+)\b/.exec(err.message)
    const code = codeFromProp ?? codeMatch?.[1] ?? name
    return { code, message: err.message, isRetryable: false, isReject: true }
  }

  return { code: 'unknown', message: err.message, isRetryable: false, isReject: false }
}

export function sleepWithJitter(ms: number, jitterFraction = 0.2): Promise<void> {
  const jitter = ms * jitterFraction * Math.random()
  return new Promise(resolve => setTimeout(resolve, Math.round(ms + jitter)))
}
