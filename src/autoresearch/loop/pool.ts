/** Minimal async semaphore for capping parallelism. */
export class Semaphore {
  private available: number
  private readonly queue: (() => void)[] = []

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`Semaphore capacity must be a positive integer, got ${String(capacity)}`)
    }
    this.available = capacity
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1
      return
    }
    await new Promise<void>(resolve => {
      this.queue.push(resolve)
    })
  }

  release(): void {
    const next = this.queue.shift()
    if (next !== undefined) {
      next()
      return
    }
    this.available = Math.min(this.capacity, this.available + 1)
  }

  async withLease<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}
