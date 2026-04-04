import type { QuoteAggregationContext, QuoteCandle1s, QuoteEvent } from '../types.js'

interface CandleAccumulator {
  second: number
  bidOpen: number | null
  bidHigh: number | null
  bidLow: number | null
  bidClose: number | null
  askOpen: number | null
  askHigh: number | null
  askLow: number | null
  askClose: number | null
}

function updateLeg(
  open: number | null,
  high: number | null,
  low: number | null,
  _close: number | null,
  value: number | null
): [number | null, number | null, number | null, number | null] {
  if (value === null) {
    return [open, high, low, null]
  }

  const nextOpen = open ?? value
  const nextHigh = high === null ? value : Math.max(high, value)
  const nextLow = low === null ? value : Math.min(low, value)

  return [nextOpen, nextHigh, nextLow, value]
}

function createAccumulator(second: number, bid: number | null, ask: number | null): CandleAccumulator {
  return {
    second,
    bidOpen: bid,
    bidHigh: bid,
    bidLow: bid,
    bidClose: bid,
    askOpen: ask,
    askHigh: ask,
    askLow: ask,
    askClose: ask,
  }
}

function applyEvent(accumulator: CandleAccumulator, bid: number | null, ask: number | null): void {
  if (bid !== null) {
    const [open, high, low, close] = updateLeg(
      accumulator.bidOpen,
      accumulator.bidHigh,
      accumulator.bidLow,
      accumulator.bidClose,
      bid
    )

    accumulator.bidOpen = open
    accumulator.bidHigh = high
    accumulator.bidLow = low
    accumulator.bidClose = close
  }

  if (ask !== null) {
    const [open, high, low, close] = updateLeg(
      accumulator.askOpen,
      accumulator.askHigh,
      accumulator.askLow,
      accumulator.askClose,
      ask
    )

    accumulator.askOpen = open
    accumulator.askHigh = high
    accumulator.askLow = low
    accumulator.askClose = close
  }
}

function missingReasonFromState(bid: number | null, ask: number | null): string | null {
  return bid !== null && ask !== null ? null : 'no_prior_state'
}

function toCandle(
  accumulator: CandleAccumulator,
  context: QuoteAggregationContext,
  isInterpolated: boolean
): QuoteCandle1s {
  return {
    ts: accumulator.second,
    exchange: context.exchange,
    symbol: context.symbol,
    bidOpen: accumulator.bidOpen,
    bidHigh: accumulator.bidHigh,
    bidLow: accumulator.bidLow,
    bidClose: accumulator.bidClose,
    askOpen: accumulator.askOpen,
    askHigh: accumulator.askHigh,
    askLow: accumulator.askLow,
    askClose: accumulator.askClose,
    sourceType: context.sourceType,
    isInterpolated,
    confidenceScore: context.confidenceScore,
    missingReason: missingReasonFromState(accumulator.bidClose, accumulator.askClose),
  }
}

function interpolatedCandle(
  second: number,
  bid: number | null,
  ask: number | null,
  context: QuoteAggregationContext
): QuoteCandle1s {
  return {
    ts: second,
    exchange: context.exchange,
    symbol: context.symbol,
    bidOpen: bid,
    bidHigh: bid,
    bidLow: bid,
    bidClose: bid,
    askOpen: ask,
    askHigh: ask,
    askLow: ask,
    askClose: ask,
    sourceType: context.sourceType,
    isInterpolated: true,
    confidenceScore: context.confidenceScore,
    missingReason: missingReasonFromState(bid, ask),
  }
}

export async function* aggregateQuoteEvents(
  events: AsyncIterable<QuoteEvent>,
  context: QuoteAggregationContext
): AsyncIterable<QuoteCandle1s> {
  let current: CandleAccumulator | null = null
  let lastKnownBid: number | null = null
  let lastKnownAsk: number | null = null

  for await (const event of events) {
    const secondBucket = Math.floor(event.timestampMs / 1000)
    const resolvedBid = event.bid ?? lastKnownBid
    const resolvedAsk = event.ask ?? lastKnownAsk

    if (current === null) {
      current = createAccumulator(secondBucket, resolvedBid, resolvedAsk)
    } else if (secondBucket > current.second) {
      yield toCandle(current, context, false)

      for (let gapSecond = current.second + 1; gapSecond < secondBucket; gapSecond += 1) {
        yield interpolatedCandle(gapSecond, lastKnownBid, lastKnownAsk, context)
      }

      current = createAccumulator(secondBucket, resolvedBid, resolvedAsk)
    } else if (secondBucket === current.second) {
      applyEvent(current, resolvedBid, resolvedAsk)
    } else {
      throw new Error(
        `Input events must be sorted by timestamp. Received ${String(secondBucket)} after ${String(current.second)}`
      )
    }

    if (event.bid !== null) {
      lastKnownBid = event.bid
    }

    if (event.ask !== null) {
      lastKnownAsk = event.ask
    }
  }

  if (current !== null) {
    yield toCandle(current, context, false)
  }
}
