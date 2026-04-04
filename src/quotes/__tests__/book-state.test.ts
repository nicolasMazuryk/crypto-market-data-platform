import { describe, expect, it } from 'vitest'

import { BookState } from '../orderbook/book-state.js'

describe('BookState', () => {
  it('returns null for an empty book', () => {
    const book = new BookState()

    expect(book.getBestBid()).toBeNull()
    expect(book.getBestAsk()).toBeNull()

    book.applySnapshot([], [])
    expect(book.getBestBid()).toBeNull()
    expect(book.getBestAsk()).toBeNull()
  })

  it('applies snapshots and returns best bid/ask', () => {
    const book = new BookState()

    book.applySnapshot(
      [
        [100, 2],
        [99, 5],
      ],
      [
        [101, 1],
        [102, 3],
      ]
    )

    expect(book.getBestBid()).toBe(100)
    expect(book.getBestAsk()).toBe(101)
  })

  it('computes best levels from snapshot even when input levels are unsorted', () => {
    const book = new BookState()

    book.applySnapshot(
      [
        [98, 2],
        [101, 1],
        [100, 3],
      ],
      [
        [105, 2],
        [102, 1],
        [103, 3],
      ]
    )

    expect(book.getBestBid()).toBe(101)
    expect(book.getBestAsk()).toBe(102)
  })

  it('preserves cached best levels when non-best deltas are applied', () => {
    const book = new BookState()

    book.applySnapshot(
      [
        [100, 1],
        [99, 1],
      ],
      [
        [101, 1],
        [102, 1],
      ]
    )

    expect(book.getBestBid()).toBe(100)
    expect(book.getBestAsk()).toBe(101)

    book.applyDelta(
      [
        [98, 10],
        [99, 5],
      ],
      [
        [103, 1],
        [104, 2],
      ]
    )

    expect(book.getBestBid()).toBe(100)
    expect(book.getBestAsk()).toBe(101)
  })

  it('applies deltas including deletions', () => {
    const book = new BookState()

    book.applySnapshot(
      [
        [100, 2],
        [99, 5],
      ],
      [
        [101, 1],
        [102, 3],
      ]
    )

    book.applyDelta(
      [
        [100, 0],
        [98, 9],
      ],
      [
        [101, 0],
        [100.5, 4],
      ]
    )

    expect(book.getBestBid()).toBe(99)
    expect(book.getBestAsk()).toBe(100.5)
  })

  it('invalidates best-level cache when best levels are deleted', () => {
    const book = new BookState()

    book.applySnapshot(
      [
        [100, 1],
        [99, 1],
      ],
      [
        [101, 1],
        [102, 1],
      ]
    )

    expect(book.getBestBid()).toBe(100)
    expect(book.getBestAsk()).toBe(101)

    book.applyDelta([[100, 0]], [[101, 0]])

    expect(book.getBestBid()).toBe(99)
    expect(book.getBestAsk()).toBe(102)
  })
})
