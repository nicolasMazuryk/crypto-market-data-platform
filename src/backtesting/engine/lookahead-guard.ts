import type { OrderbookRow } from '../../db/types.js'
import type { OHLCWindow } from '../data/types.js'

export class LookaheadViolationError extends Error {
  constructor(requestedTs: string, currentTs: string) {
    super(`Lookahead violation: requested data at ${requestedTs} but current time is ${currentTs}`)
    this.name = 'LookaheadViolationError'
  }
}

/**
 * Time-gated wrapper around OHLCWindow.
 * Prevents strategies from accessing future data.
 * The engine advances currentTime as it processes each second.
 */
export class TimeGatedWindow {
  private readonly inner: OHLCWindow
  private currentTime: string

  constructor(window: OHLCWindow, initialTime: string) {
    this.inner = window
    this.currentTime = initialTime
  }

  /** Advance the current time gate */
  advanceTo(ts: string): void {
    if (ts < this.currentTime) {
      throw new Error(`Cannot move time backwards: ${ts} < ${this.currentTime}`)
    }
    this.currentTime = ts
  }

  /** Get current time gate */
  getCurrentTime(): string {
    return this.currentTime
  }

  /** Get row at timestamp — throws if in the future */
  getRowAt(ts: string): OrderbookRow | undefined {
    if (ts > this.currentTime) {
      throw new LookaheadViolationError(ts, this.currentTime)
    }
    return this.inner.getRowAt(ts)
  }

  /** Get rows in range — throws if endTs is in the future */
  getRowsInRange(startTs: string, endTs: string): OrderbookRow[] {
    if (endTs > this.currentTime) {
      throw new LookaheadViolationError(endTs, this.currentTime)
    }
    return this.inner.getRowsInRange(startTs, endTs)
  }

  /** Get all rows up to current time */
  getRowsUpToCurrent(): OrderbookRow[] {
    const first = this.inner.getFirstTs()
    if (!first) return []
    return this.inner.getRowsInRange(first, this.currentTime)
  }

  /** Check timestamp exists — only for past/present */
  hasTimestamp(ts: string): boolean {
    if (ts > this.currentTime) {
      throw new LookaheadViolationError(ts, this.currentTime)
    }
    return this.inner.hasTimestamp(ts)
  }

  /** Get the underlying window (for direct access by the engine — not by strategies) */
  getInner(): OHLCWindow {
    return this.inner
  }
}
