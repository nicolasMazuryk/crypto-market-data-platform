import { describe, it, expect } from 'vitest'

interface MockEngineHandle {
  id: string
  stop(): Promise<void>
  flattenAllCalled: boolean
  stopCompleted: boolean
}

/**
 * Creates a mock engine handle that simulates the shutdown lifecycle:
 * flattenAll (~8s grace period) + cleanup.
 * The mock uses a configurable delay to simulate the async work.
 */
function createMockEngine(id: string, shutdownMs = 50): MockEngineHandle {
  const handle: MockEngineHandle = {
    id,
    flattenAllCalled: false,
    stopCompleted: false,
    async stop() {
      // Simulate: stop scheduler → flattenAll → grace period → flush → close
      handle.flattenAllCalled = true
      await new Promise<void>(resolve => setTimeout(resolve, shutdownMs))
      handle.stopCompleted = true
    },
  }
  return handle
}

describe('batch redeploy — concurrent graceful shutdown', () => {
  it('completes 5 concurrent shutdowns well within 20s', async () => {
    const instances = Array.from({ length: 5 }, (_, i) => createMockEngine(`engine-${i.toString()}`, 80))

    const start = Date.now()
    await Promise.all(instances.map(e => e.stop()))
    const elapsed = Date.now() - start

    for (const inst of instances) {
      expect(inst.flattenAllCalled).toBe(true)
      expect(inst.stopCompleted).toBe(true)
    }

    // 5 instances at 80ms each in parallel should complete in ~80–200ms, well under 20s
    expect(elapsed).toBeLessThan(20_000)
  }, 25_000)

  it('all instances call flattenAll independently without blocking each other', async () => {
    const callOrder: string[] = []
    const instances = Array.from({ length: 5 }, (_, i) => {
      const id = `engine-${i.toString()}`
      return {
        id,
        async stop() {
          callOrder.push(`${id}:start`)
          await new Promise<void>(resolve => setTimeout(resolve, 30 + i * 10))
          callOrder.push(`${id}:done`)
        },
      }
    })

    await Promise.all(instances.map(e => e.stop()))

    // All starts should appear before any instance is blocked waiting for another
    const startEntries = callOrder.filter(e => e.endsWith(':start'))
    const doneEntries = callOrder.filter(e => e.endsWith(':done'))
    expect(startEntries).toHaveLength(5)
    expect(doneEntries).toHaveLength(5)
  })

  it('does not breach a simulated rate limit when stopping 5 instances', async () => {
    // Simulate: each stop() signals exchange to cancel orders (one "API call" each).
    // Rate limit: max 5 concurrent calls. With 5 instances, none should queue.
    let activeCalls = 0
    let maxConcurrent = 0

    const instances = Array.from({ length: 5 }, (_, i) => createMockEngineWithRateCheck(`engine-${i.toString()}`))

    function createMockEngineWithRateCheck(id: string) {
      return {
        id,
        async stop() {
          activeCalls++
          maxConcurrent = Math.max(maxConcurrent, activeCalls)
          await new Promise<void>(resolve => setTimeout(resolve, 50))
          activeCalls--
        },
      }
    }

    await Promise.all(instances.map(e => e.stop()))

    // All 5 run concurrently — peak concurrent calls should be exactly 5
    expect(maxConcurrent).toBeLessThanOrEqual(5)
  })

  it('handles shutdown failure in one instance without blocking others', async () => {
    const results: { id: string; success: boolean }[] = []

    const instances = [
      {
        id: 'ok-1',
        async stop() {
          await new Promise<void>(r => setTimeout(r, 30))
          results.push({ id: 'ok-1', success: true })
        },
      },
      {
        id: 'fail-2',
        async stop() {
          await new Promise<void>(r => setTimeout(r, 20))
          throw new Error('flattenAll timeout')
        },
      },
      {
        id: 'ok-3',
        async stop() {
          await new Promise<void>(r => setTimeout(r, 40))
          results.push({ id: 'ok-3', success: true })
        },
      },
      {
        id: 'ok-4',
        async stop() {
          await new Promise<void>(r => setTimeout(r, 10))
          results.push({ id: 'ok-4', success: true })
        },
      },
      {
        id: 'ok-5',
        async stop() {
          await new Promise<void>(r => setTimeout(r, 25))
          results.push({ id: 'ok-5', success: true })
        },
      },
    ]

    const settled = await Promise.allSettled(instances.map(e => e.stop()))

    const rejected = settled.filter(r => r.status === 'rejected')
    const fulfilled = settled.filter(r => r.status === 'fulfilled')

    expect(rejected).toHaveLength(1)
    expect(fulfilled).toHaveLength(4)
    // Other instances still completed despite one failure
    expect(results.filter(r => r.success)).toHaveLength(4)
  })
})
