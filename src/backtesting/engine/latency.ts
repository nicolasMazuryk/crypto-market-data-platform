import { toClickHouseDateTime } from '../../db/types.js'
import type { ClickHouseDateTime } from '../../db/types.js'

/**
 * Shift a decision timestamp forward by the simulated order-placement latency to
 * produce the fill/receipt timestamp. Data is 1s granularity, so 1000ms = 1 candle.
 */
export function applyOrderLatency(decisionTs: ClickHouseDateTime, orderLatencyMs: number): ClickHouseDateTime {
  const decisionDate = new Date(decisionTs.replace(' ', 'T') + 'Z')
  return toClickHouseDateTime(new Date(decisionDate.getTime() + orderLatencyMs))
}
