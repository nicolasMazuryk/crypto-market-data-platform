import { closeClickHouseClient } from '../db/client.js'
import { assertClickHouseHealthy } from '../db/health.js'
import { listFundingRateTimeGaps, type FundingRateTimeGap } from '../db/queries/fundingRates.js'

interface SymbolGapSummary {
  exchange: string
  symbol: string
  gaps: FundingRateTimeGap[]
  gap_count: number
  max_gap_hours: number
}

function buildTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => (row[index] ? row[index].length : 0)))
  )

  const formatRow = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(' | ')

  const separator = widths.map(width => '-'.repeat(width)).join('-|-')
  return [formatRow(headers), separator, ...rows.map(formatRow)].join('\n')
}

function summarizeGaps(gaps: FundingRateTimeGap[]): SymbolGapSummary[] {
  const grouped = new Map<string, { exchange: string; symbol: string; gaps: FundingRateTimeGap[] }>()

  for (const gap of gaps) {
    const key = `${gap.exchange}:${gap.symbol}`
    const existing = grouped.get(key)

    if (existing) {
      existing.gaps.push(gap)
      continue
    }

    grouped.set(key, {
      exchange: gap.exchange,
      symbol: gap.symbol,
      gaps: [gap],
    })
  }

  return Array.from(grouped.values())
    .map(group => {
      let maxGap = 0
      for (const gap of group.gaps) {
        if (gap.gap_hours > maxGap) {
          maxGap = gap.gap_hours
        }
      }

      return {
        exchange: group.exchange,
        symbol: group.symbol,
        gaps: group.gaps,
        gap_count: group.gaps.length,
        max_gap_hours: maxGap,
      }
    })
    .sort((a, b) => {
      if (a.exchange === b.exchange) {
        return a.symbol.localeCompare(b.symbol)
      }

      return a.exchange.localeCompare(b.exchange)
    })
}

function printSummaryTable(summaries: SymbolGapSummary[]): void {
  if (summaries.length === 0) {
    return
  }

  const rows = summaries.map(summary => [
    summary.exchange,
    summary.symbol,
    String(summary.gap_count),
    String(summary.max_gap_hours),
  ])

  console.log('Summary')
  console.log(buildTable(['exchange', 'symbol', 'gap_count', 'max_gap_hours'], rows))
  console.log('')
}

function printExamples(summaries: SymbolGapSummary[]): void {
  if (summaries.length === 0) {
    return
  }

  console.log('Examples')
  for (const summary of summaries) {
    const gapWord = summary.gap_count === 1 ? 'gap' : 'gaps'
    const gapCount = String(summary.gap_count)
    const maxGapHours = String(summary.max_gap_hours)
    console.log(`[${summary.exchange}] ${summary.symbol} - ${gapCount} ${gapWord}, max ${maxGapHours}h`)

    const examples = summary.gaps.slice(0, 3)
    for (const [index, gap] of examples.entries()) {
      const gapIndex = String(index + 1)
      const gapHours = String(gap.gap_hours)
      console.log(`  Gap ${gapIndex}: ${gap.prev_time} -> ${gap.curr_time} (${gapHours}h)`)
    }

    if (summary.gaps.length > examples.length) {
      const remaining = String(summary.gaps.length - examples.length)
      console.log(`  ... ${remaining} more gap(s)`)
    }

    console.log('')
  }
}

async function main(): Promise<void> {
  await assertClickHouseHealthy()

  const gaps = await listFundingRateTimeGaps()
  const summaries = summarizeGaps(gaps)

  if (summaries.length === 0) {
    console.log('No gaps found ✓')
    process.exitCode = 0
    return
  }

  printSummaryTable(summaries)
  printExamples(summaries)

  const exchangeCount = String(new Set(summaries.map(summary => summary.exchange)).size)
  const symbolCount = String(summaries.length)
  console.log(`${symbolCount} symbol(s) with gaps found across ${exchangeCount} exchanges`)
  process.exitCode = 1
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  try {
    await closeClickHouseClient()
  } catch (error) {
    console.error(error)
  }
}
