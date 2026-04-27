import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { gracefulShutdown } from '../graceful-shutdown.js'

describe('gracefulShutdown', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    vi.useRealTimers()
    exitSpy.mockRestore()
  })

  it('waits drainSeconds before calling handle.stop()', async () => {
    const handle = { stop: vi.fn().mockResolvedValue(undefined) }
    const drainSeconds = 5

    const promise = gracefulShutdown(handle, { drainSeconds, exitOnComplete: false })

    expect(handle.stop).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(drainSeconds * 1000)
    await promise

    expect(handle.stop).toHaveBeenCalledOnce()
  })

  it('calls handle.stop() immediately when drainSeconds is 0', async () => {
    const handle = { stop: vi.fn().mockResolvedValue(undefined) }

    await gracefulShutdown(handle, { drainSeconds: 0, exitOnComplete: false })

    expect(handle.stop).toHaveBeenCalledOnce()
  })

  it('awaits handle.stop() before resolving', async () => {
    let resolved = false
    const handle = {
      stop: vi.fn().mockImplementation(async () => {
        await new Promise<void>(r => setTimeout(r, 100))
        resolved = true
      }),
    }

    const promise = gracefulShutdown(handle, { drainSeconds: 0, exitOnComplete: false })
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(100)
    await promise

    expect(resolved).toBe(true)
  })

  it('calls process.exit with exitCode when exitOnComplete is true', async () => {
    const handle = { stop: vi.fn().mockResolvedValue(undefined) }

    await gracefulShutdown(handle, { drainSeconds: 0, exitOnComplete: true })

    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('respects process.exitCode when calling process.exit', async () => {
    const handle = { stop: vi.fn().mockResolvedValue(undefined) }
    process.exitCode = 1

    await gracefulShutdown(handle, { drainSeconds: 0, exitOnComplete: true })

    expect(exitSpy).toHaveBeenCalledWith(1)
    process.exitCode = 0
  })

  it('does not call process.exit when exitOnComplete is false', async () => {
    const handle = { stop: vi.fn().mockResolvedValue(undefined) }

    await gracefulShutdown(handle, { drainSeconds: 0, exitOnComplete: false })

    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('calls onDrained after drain and before handle.stop()', async () => {
    const calls: string[] = []
    const handle = {
      stop: vi.fn().mockImplementation(async () => {
        calls.push('stop')
      }),
    }
    const onDrained = vi.fn().mockImplementation(() => {
      calls.push('onDrained')
    })

    const promise = gracefulShutdown(handle, { drainSeconds: 3, exitOnComplete: false, onDrained })

    await vi.advanceTimersByTimeAsync(3000)
    await promise

    expect(calls).toEqual(['onDrained', 'stop'])
  })

  it('is idempotent — second call on same handle returns early without calling stop again', async () => {
    const handle = { stop: vi.fn().mockResolvedValue(undefined) }

    await gracefulShutdown(handle, { drainSeconds: 0, exitOnComplete: false })
    await gracefulShutdown(handle, { drainSeconds: 0, exitOnComplete: false })

    expect(handle.stop).toHaveBeenCalledOnce()
  })
})
