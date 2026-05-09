import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({
  closeClickHouseClient: vi.fn().mockResolvedValue(undefined),
  getClickHouseClient: vi.fn(),
}))

import { closeClickHouseClient } from '../client.js'
import { withClickHouseRetry } from '../retry.js'

describe('withClickHouseRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('resolves immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withClickHouseRetry(fn)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(closeClickHouseClient).not.toHaveBeenCalled()
  })

  it('retries on socket hang up and resolves after recovery', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue('recovered')

    const promise = withClickHouseRetry(fn)
    // advance past backoff delays
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(closeClickHouseClient).toHaveBeenCalledTimes(2)
  })

  it('does not retry on non-matching errors', async () => {
    const fn = vi.fn().mockRejectedValue(new RangeError('out of bounds'))
    await expect(withClickHouseRetry(fn)).rejects.toThrow('out of bounds')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(closeClickHouseClient).not.toHaveBeenCalled()
  })

  it('retries on ECONNRESET', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('ok')

    const promise = withClickHouseRetry(fn)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('throws after exceeding MAX_CONSECUTIVE_RETRIES (50)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('socket hang up'))

    const promise = withClickHouseRetry(fn)
    // Attach handler immediately to avoid unhandled-rejection warning while
    // timers run through all 50 backoff sleeps.
    const settled = promise.catch((e: unknown) => e)
    await vi.runAllTimersAsync()

    const result = await settled
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toBe('socket hang up')
    // 1 initial + 50 retries = 51 total calls
    expect(fn).toHaveBeenCalledTimes(51)
    expect(closeClickHouseClient).toHaveBeenCalledTimes(50)
  })
})
