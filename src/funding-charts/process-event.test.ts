import { describe, expect, it, vi } from 'vitest'

import { processFundingChartEvent } from './process-event.js'
import type { ChartConfig, FundingEvent } from './types.js'

const event: FundingEvent = {
  exchange: 'bybit',
  symbol: 'MBLUSDT',
  funding_time: new Date('2025-01-01T00:00:00.000Z'),
  funding_rate: -0.00302,
}

const config: ChartConfig = {
  funding_rate_threshold: -0.003,
  threshold_mode: 'lte',
  exchanges: [],
  symbols: [],
  date_range: { from: null, to: null },
  pre_seconds: 30,
  post_seconds: 180,
  output_dir: './out',
  image_width: 1920,
  image_height: 900,
  overwrite: false,
  worker_count: 1,
  db_concurrency_per_worker: 1,
  show_fib_ladder: true,
  show_spread_shade: false,
}

describe('processFundingChartEvent', () => {
  it('skips events with no orderbook rows without building paths, rendering, or writing files', async () => {
    const dependencies = {
      fetchRows: vi.fn().mockResolvedValue([]),
      buildOutputPath: vi.fn(),
      renderChart: vi.fn(),
      writePng: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }

    const result = await processFundingChartEvent(event, config, dependencies)

    expect(result).toBe('skipped_no_orderbook')
    expect(dependencies.fetchRows).toHaveBeenCalledWith(event, config.pre_seconds, config.post_seconds)
    expect(dependencies.buildOutputPath).not.toHaveBeenCalled()
    expect(dependencies.renderChart).not.toHaveBeenCalled()
    expect(dependencies.writePng).not.toHaveBeenCalled()
    expect(dependencies.warn).toHaveBeenCalledWith(
      { exchange: 'bybit', symbol: 'MBLUSDT', funding_time: event.funding_time },
      'no orderbook data for event'
    )
  })
})
