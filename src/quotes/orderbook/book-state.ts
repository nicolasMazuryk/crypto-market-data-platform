export type PriceLevel = readonly [number, number]

export class BookState {
  private readonly bids = new Map<number, number>()
  private readonly asks = new Map<number, number>()
  private bestBid: number | null = null
  private bestAsk: number | null = null
  private bestBidDirty = false
  private bestAskDirty = false

  private recomputeBestBid(): number | null {
    let best: number | null = null

    for (const [price] of this.bids) {
      if (best === null || price > best) {
        best = price
      }
    }

    this.bestBid = best
    this.bestBidDirty = false
    return best
  }

  private recomputeBestAsk(): number | null {
    let best: number | null = null

    for (const [price] of this.asks) {
      if (best === null || price < best) {
        best = price
      }
    }

    this.bestAsk = best
    this.bestAskDirty = false
    return best
  }

  applySnapshot(bids: PriceLevel[], asks: PriceLevel[]): void {
    this.bids.clear()
    this.asks.clear()
    this.bestBid = null
    this.bestAsk = null
    this.bestBidDirty = false
    this.bestAskDirty = false

    for (const [price, size] of bids) {
      if (size > 0) {
        this.bids.set(price, size)
        if (this.bestBid === null || price > this.bestBid) {
          this.bestBid = price
        }
      }
    }

    for (const [price, size] of asks) {
      if (size > 0) {
        this.asks.set(price, size)
        if (this.bestAsk === null || price < this.bestAsk) {
          this.bestAsk = price
        }
      }
    }
  }

  applyDelta(bids: PriceLevel[], asks: PriceLevel[]): void {
    for (const [price, size] of bids) {
      if (size <= 0) {
        const removed = this.bids.delete(price)
        if (removed && this.bestBid === price) {
          this.bestBidDirty = true
        }
        continue
      }

      this.bids.set(price, size)
      if (this.bestBid === null || price > this.bestBid) {
        this.bestBid = price
        this.bestBidDirty = false
      } else if (this.bestBidDirty && this.bestBid === price) {
        this.bestBidDirty = false
      }
    }

    for (const [price, size] of asks) {
      if (size <= 0) {
        const removed = this.asks.delete(price)
        if (removed && this.bestAsk === price) {
          this.bestAskDirty = true
        }
        continue
      }

      this.asks.set(price, size)
      if (this.bestAsk === null || price < this.bestAsk) {
        this.bestAsk = price
        this.bestAskDirty = false
      } else if (this.bestAskDirty && this.bestAsk === price) {
        this.bestAskDirty = false
      }
    }
  }

  getBestBid(): number | null {
    if (this.bestBidDirty) {
      return this.recomputeBestBid()
    }

    return this.bestBid
  }

  getBestAsk(): number | null {
    if (this.bestAskDirty) {
      return this.recomputeBestAsk()
    }

    return this.bestAsk
  }
}
