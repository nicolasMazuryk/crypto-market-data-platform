import { describe, expect, it } from 'vitest'

import { Semaphore } from '../loop/pool.js'

describe('Semaphore', () => {
  it('caps concurrency to capacity', async () => {
    const sem = new Semaphore(2)
    let active = 0
    let peak = 0
    const tasks = Array.from({ length: 6 }, () =>
      sem.withLease(async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise<void>(resolve => setTimeout(resolve, 5))
        active -= 1
      })
    )
    await Promise.all(tasks)
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('throws on non-positive capacity', () => {
    expect(() => new Semaphore(0)).toThrow()
    expect(() => new Semaphore(-1)).toThrow()
  })
})
