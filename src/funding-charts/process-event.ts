import type { ChartConfig, FundingEvent, OrderbookRow } from './types.js'

export type ProcessFundingChartEventResult = 'rendered' | 'skipped_existing' | 'skipped_no_orderbook'

export interface ProcessFundingChartEventDeps {
  fetchRows: (event: FundingEvent, preSeconds: number, postSeconds: number) => Promise<OrderbookRow[]>
  buildOutputPath: (event: FundingEvent, outDir: string) => string
  renderChart: (event: FundingEvent, rows: OrderbookRow[], config: ChartConfig) => Buffer
  writePng: (filePath: string, buf: Buffer, overwrite: boolean) => Promise<boolean>
  warn: (obj: Record<string, unknown>, msg: string) => void
  debug: (obj: Record<string, unknown>, msg: string) => void
}

export async function processFundingChartEvent(
  event: FundingEvent,
  config: ChartConfig,
  deps: ProcessFundingChartEventDeps
): Promise<ProcessFundingChartEventResult> {
  const rows = await deps.fetchRows(event, config.pre_seconds, config.post_seconds)

  if (rows.length === 0) {
    deps.warn(
      { exchange: event.exchange, symbol: event.symbol, funding_time: event.funding_time },
      'no orderbook data for event'
    )
    return 'skipped_no_orderbook'
  }

  const outPath = deps.buildOutputPath(event, config.output_dir)
  const buf = deps.renderChart(event, rows, config)
  const written = await deps.writePng(outPath, buf, config.overwrite)

  if (!written) {
    deps.debug({ path: outPath }, 'skipped existing file')
    return 'skipped_existing'
  }

  return 'rendered'
}
