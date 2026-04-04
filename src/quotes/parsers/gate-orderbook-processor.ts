import { BookState } from '../orderbook/index.js'
import type { QuoteEvent } from '../types.js'
import { splitCsvLine, toFiniteNumber, unixSecondsToMs } from './csv.js'

type GateAction = 'set' | 'make' | 'take'
type Side = 'bid' | 'ask'

interface ParsedGateRow {
  readonly timestampMs: number
  readonly action: GateAction
  readonly side: Side
  readonly price: number
  readonly levelSize: number
}

type LevelMap = Map<number, number>
type PriceLevel = [number, number]

function toPriceLevels(levels: LevelMap): PriceLevel[] {
  const output: PriceLevel[] = []
  for (const [price, size] of levels) {
    if (size > 0) {
      output.push([price, size])
    }
  }

  return output
}

function parseGateRow(line: string): ParsedGateRow | null {
  if (line.trim().length === 0) {
    return null
  }

  const columns = splitCsvLine(line)
  const timestampMs = unixSecondsToMs(columns[0])
  const action = columns[1]?.trim().toLowerCase()
  const price = toFiniteNumber(columns[2])
  const signedSize = toFiniteNumber(columns[3])

  if (
    timestampMs === null ||
    (action !== 'set' && action !== 'make' && action !== 'take') ||
    price === null ||
    signedSize === null ||
    signedSize === 0
  ) {
    return null
  }

  return {
    timestampMs,
    action,
    side: signedSize > 0 ? 'bid' : 'ask',
    price,
    levelSize: Math.abs(signedSize),
  }
}

export class GateOrderbookProcessor {
  private readonly book = new BookState()
  private readonly bidLevels: LevelMap = new Map()
  private readonly askLevels: LevelMap = new Map()

  private currentTimestampMs: number | null = null
  private hasUpdates = false
  private pendingSnapshotBids: LevelMap | null = null
  private pendingSnapshotAsks: LevelMap | null = null

  private upsertLevel(side: Side, price: number, nextSize: number): void {
    const levels = side === 'bid' ? this.bidLevels : this.askLevels
    const isBid = side === 'bid'

    if (nextSize <= 0) {
      levels.delete(price)
      if (isBid) {
        this.book.applyDelta([[price, 0]], [])
      } else {
        this.book.applyDelta([], [[price, 0]])
      }
      return
    }

    levels.set(price, nextSize)
    if (isBid) {
      this.book.applyDelta([[price, nextSize]], [])
    } else {
      this.book.applyDelta([], [[price, nextSize]])
    }
  }

  private beginSnapshot(): void {
    if (this.pendingSnapshotBids !== null && this.pendingSnapshotAsks !== null) {
      return
    }

    this.pendingSnapshotBids = new Map()
    this.pendingSnapshotAsks = new Map()
  }

  private setSnapshotLevel(side: Side, price: number, levelSize: number): void {
    this.beginSnapshot()

    const target = side === 'bid' ? this.pendingSnapshotBids : this.pendingSnapshotAsks
    if (!target) {
      return
    }

    if (levelSize <= 0) {
      target.delete(price)
      return
    }

    target.set(price, levelSize)
  }

  private applyPendingSnapshot(): void {
    if (this.pendingSnapshotBids === null || this.pendingSnapshotAsks === null) {
      return
    }

    this.bidLevels.clear()
    this.askLevels.clear()

    for (const [price, size] of this.pendingSnapshotBids) {
      this.bidLevels.set(price, size)
    }

    for (const [price, size] of this.pendingSnapshotAsks) {
      this.askLevels.set(price, size)
    }

    this.book.applySnapshot(toPriceLevels(this.bidLevels), toPriceLevels(this.askLevels))
    this.pendingSnapshotBids = null
    this.pendingSnapshotAsks = null
  }

  private applyDelta(action: Exclude<GateAction, 'set'>, side: Side, price: number, levelSize: number): void {
    const levels = side === 'bid' ? this.bidLevels : this.askLevels
    const current = levels.get(price) ?? 0
    const next = action === 'make' ? current + levelSize : current - levelSize
    this.upsertLevel(side, price, next)
  }

  private processRow(row: ParsedGateRow): void {
    if (row.action === 'set') {
      this.setSnapshotLevel(row.side, row.price, row.levelSize)
    } else {
      this.applyPendingSnapshot()
      this.applyDelta(row.action, row.side, row.price, row.levelSize)
    }

    this.hasUpdates = true
  }

  private flushTimestamp(): QuoteEvent | null {
    if (this.currentTimestampMs === null || !this.hasUpdates) {
      return null
    }

    this.applyPendingSnapshot()

    const event: QuoteEvent = {
      timestampMs: this.currentTimestampMs,
      bid: this.book.getBestBid(),
      ask: this.book.getBestAsk(),
      sourceType: 'orderbook',
    }

    this.hasUpdates = false
    return event
  }

  pushLine(line: string): QuoteEvent | null {
    const row = parseGateRow(line)
    if (!row) {
      return null
    }

    if (this.currentTimestampMs === null) {
      this.currentTimestampMs = row.timestampMs
      this.processRow(row)
      return null
    }

    if (row.timestampMs !== this.currentTimestampMs) {
      const emitted = this.flushTimestamp()
      this.currentTimestampMs = row.timestampMs
      this.processRow(row)
      return emitted
    }

    this.processRow(row)
    return null
  }

  finish(): QuoteEvent | null {
    const emitted = this.flushTimestamp()
    this.currentTimestampMs = null
    return emitted
  }
}
