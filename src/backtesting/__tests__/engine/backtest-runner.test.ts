import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../data/funding-events.js', () => ({
  queryPositiveFundingEvents: vi.fn(),
  queryAllFundingEventsByExchange: vi.fn(),
  queryFundingEvents: vi.fn(),
  queryMainExchangeCrossEvents: vi.fn(),
}))

vi.mock('../../data/orderbook-window.js', () => ({
  fetchOrderbookWindow: vi.fn(),
}))

vi.mock('../../data/spot-data.js', () => ({
  fetchSpotOrderbookWindow: vi.fn(),
}))

import { runBacktestEngine } from '../../engine/backtest-runner.js'
import type { ResolvedConfig } from '../../config/schema.js'
import type { FundingEvent } from '../../data/types.js'
import { queryPositiveFundingEvents, queryAllFundingEventsByExchange } from '../../data/funding-events.js'
import { fetchOrderbookWindow } from '../../data/orderbook-window.js'
import { buildWindow } from '../e2e/fixtures.js'

function makeConfig(): ResolvedConfig {
  return {
    base: {
      exchange: 'binanceusdm',
      start_date: '2025-06-01T00:00:00Z',
      end_date: '2025-06-03T00:00:00Z',
      fees: { binanceusdm: { taker_fee: 0.0004, maker_fee: 0.0002 } },
      spot_fees: { binanceusdm: { fee: 0.001 } },
      validation: {
        required_seconds_before: 5,
        required_seconds_after: 5,
        max_gap_seconds: 60,
        max_price_change_pct: 0.2,
      },
      window: { pre_funding_seconds: 60, post_funding_seconds: 120 },
      slippage: { stop_order_slippage: 0.0001 },
      reporting: { include_trade_log: true, output_dir: '/tmp' },
      funding_time_tolerance_seconds: 5,
    },
    strategy: {
      strategy_id: 'strategy_spot_futures',
      spot_exchange: 'binanceusdm',
      perp_exchange: 'binanceusdm',
      F_threshold: 0.0015,
      minTotalProfit: 0.0005,
      fundingConvergenceThreshold: 0.0002,
    },
  }
}

function makeEvent(time: Date, rate: number): FundingEvent {
  return { exchange: 'binanceusdm', symbol: 'BTCUSDT', funding_time: time, funding_rate: rate }
}

describe('backtest-runner: spot-futures no-overlap invariant', () => {
  const T0 = new Date('2025-06-01T00:00:00Z')
  const T4h = new Date('2025-06-01T04:00:00Z') // overlaps event-1 window; must be blocked
  const T8h = new Date('2025-06-01T08:00:00Z') // sub-threshold → triggers event-1 exit before T8h
  const T16h = new Date('2025-06-01T16:00:00Z') // well after event-1 exits; must enter
  const T24h = new Date('2025-06-02T00:00:00Z') // sub-threshold → triggers event-3 exit

  // queryPositiveFundingEvents returns only the above-threshold triggering events
  const positiveEvents: FundingEvent[] = [
    makeEvent(T0, 0.005),
    makeEvent(T4h, 0.005), // inside event-1 hold window → should be skipped
    makeEvent(T16h, 0.005), // after event-1 exits → should enter
  ]

  // Full set of funding events (including sub-threshold ones that drive carry exits)
  const allEvents: FundingEvent[] = [
    makeEvent(T0, 0.005),
    makeEvent(T4h, 0.005),
    makeEvent(T8h, 0.0001), // below fundingConvergenceThreshold → event-1 exits just before T8h
    makeEvent(T16h, 0.005),
    makeEvent(T24h, 0.0001), // below threshold → event-3 exits just before T24h
  ]

  beforeEach(() => {
    vi.mocked(queryPositiveFundingEvents).mockResolvedValue(positiveEvents)
    vi.mocked(queryAllFundingEventsByExchange).mockResolvedValue(new Map([['BTCUSDT', allEvents]]))
    vi.mocked(fetchOrderbookWindow).mockImplementation((_exchange, _symbol, fundingTime) =>
      Promise.resolve(buildWindow({ fundingTime, basePrice: 50000, preFunding: 60, postFunding: 60 }))
    )
  })

  it('blocks the overlapping event and allows the post-exit event', async () => {
    const { trades } = await runBacktestEngine(makeConfig())

    const tradeTimes = trades.map(t => t.funding_time.toISOString())
    expect(tradeTimes).toContain(T0.toISOString())
    expect(tradeTimes).not.toContain(T4h.toISOString())
    expect(tradeTimes).toContain(T16h.toISOString())
    expect(trades).toHaveLength(2)
  })

  it('returns trades sorted by funding_time ascending', async () => {
    const { trades } = await runBacktestEngine(makeConfig())

    for (let i = 1; i < trades.length; i++) {
      expect(trades[i].funding_time.getTime()).toBeGreaterThanOrEqual(trades[i - 1].funding_time.getTime())
    }
  })
})
