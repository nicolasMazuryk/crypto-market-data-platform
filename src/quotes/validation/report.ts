import path from 'node:path'

import type { FileValidationResult, PricePointStats, QuoteValidationReport } from './types.js'

function buildTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => (row[index] ? row[index].length : 0)))
  )

  const formatRow = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(' | ')

  const separator = widths.map(width => '-'.repeat(width)).join('-|-')
  return [formatRow(headers), separator, ...rows.map(formatRow)].join('\n')
}

function formatStatus(status: 'pass' | 'warn' | 'fail'): string {
  return status.toUpperCase()
}

function formatPercent(value: number, digits = 2): string {
  return `${value.toFixed(digits)}%`
}

function formatBps(value: number | null, digits = 2): string {
  if (value === null) {
    return 'n/a'
  }

  return `${value.toFixed(digits)} bps`
}

function formatPriceStats(stats: PricePointStats): string {
  if (stats.min === null || stats.max === null || stats.mean === null) {
    return 'n/a'
  }

  return `${stats.min.toFixed(6)}-${stats.max.toFixed(6)} (mean ${stats.mean.toFixed(6)})`
}

function printCheck(label: string, status: string, details: string): void {
  const filler = '.'.repeat(Math.max(2, 22 - label.length))
  const suffix = details.length > 0 ? ` (${details})` : ''
  console.log(`   ${label} ${filler} ${status}${suffix}`)
}

function printFileBlock(file: FileValidationResult): void {
  const rowCount = file.descriptor.rowCount ?? file.rowCount
  console.log(
    `-- ${file.descriptor.exchange} / ${file.descriptor.symbol} (${file.sourceType}, ${file.confidenceScore} confidence, rows=${String(rowCount)}) --`
  )

  printCheck('OHLC Integrity', file.ohlc.pass ? 'PASS' : 'FAIL', `${String(file.ohlc.violationCount)} violation(s)`)

  printCheck(
    'Spread Validity',
    formatStatus(file.spread.status),
    `${String(file.spread.totalNegativeSpreads)} negative spread(s)`
  )

  printCheck(
    'Time Continuity',
    file.timeContinuity.pass ? 'PASS' : 'FAIL',
    `${String(file.timeContinuity.actualCandles)}/${String(file.timeContinuity.expectedCandles)} candles, ${String(file.timeContinuity.missingSeconds)} missing second(s)`
  )

  console.log(
    `   Interpolation .......... ${formatPercent(file.interpolation.interpolatedPercent)} (max run: ${String(file.interpolation.maxConsecutiveInterpolatedSeconds)}s)`
  )

  printCheck(
    'Price Reasonableness',
    formatStatus(file.priceReasonableness.status),
    `bid: ${formatPriceStats(file.priceReasonableness.bidCloseStats)}, ask: ${formatPriceStats(file.priceReasonableness.askCloseStats)}`
  )

  printCheck(
    'Schema & Metadata',
    file.schemaMetadata.pass ? 'PASS' : 'FAIL',
    file.schemaMetadata.pass ? '' : 'inconsistencies detected'
  )

  printCheck(
    'Day Boundary',
    file.dayBoundary.pass ? 'PASS' : 'FAIL',
    `${String(file.dayBoundary.gapAtBoundaryCount)} gap(s), ${String(file.dayBoundary.priceJumpCount)} jump(s), ${String(file.dayBoundary.midnightMissingCount)} midnight missing`
  )

  console.log(
    `   Per-Day Quality ....... ${String(file.perDayBreakdown.badDayCount)} bad day(s) out of ${String(file.perDayBreakdown.days.length)}`
  )

  printCheck(
    'Stale Price',
    formatStatus(file.stalePrice.status),
    `${String(file.stalePrice.staleSeconds)} stale second(s), longest run ${String(file.stalePrice.longestRunSeconds)}s`
  )

  printCheck(
    'Spread Distribution',
    formatStatus(file.spreadDistribution.status),
    `median ${formatBps(file.spreadDistribution.medianBps)}, p95 ${formatBps(file.spreadDistribution.p95Bps)}`
  )

  const alignmentDetails = file.timestampAlignment.pass
    ? 'aligned to 00:00:00/23:59:59 UTC'
    : `first offset ${String(file.timestampAlignment.firstOffsetSeconds ?? 'n/a')}s, last offset ${String(file.timestampAlignment.lastOffsetSeconds ?? 'n/a')}s`
  printCheck('Timestamp Alignment', file.timestampAlignment.pass ? 'PASS' : 'WARN', alignmentDetails)

  console.log(
    `   Interpolation Damage .. score ${file.interpolationDamage.damageScore.toFixed(3)}, high-damage runs ${String(file.interpolationDamage.highDamageCount)}`
  )

  console.log(`   Quality Score: ${String(file.completeness.qualityScore)}/100`)

  if (file.criticalFailures.length > 0) {
    console.log(`   Critical: ${file.criticalFailures.join('; ')}`)
  }

  console.log('')
}

function printCrossExchange(report: QuoteValidationReport): void {
  for (const cross of report.crossExchange) {
    console.log(`-- Cross-Exchange: ${cross.symbol} (${cross.exchanges.join(', ')}) --`)
    console.log(`   Overlapping seconds: ${String(cross.overlappingSeconds)}`)
    console.log(
      `   Mean divergence: ${formatPercent(cross.meanDivergencePercent, 3)}  |  Max: ${formatPercent(cross.maxDivergencePercent, 3)}`
    )
    console.log('')
  }
}

function printSummaryTable(report: QuoteValidationReport): void {
  const rows = report.files.map(file => [
    file.descriptor.exchange,
    file.descriptor.symbol,
    file.sourceType,
    String(file.rowCount),
    String(file.perDayBreakdown.days.length),
    String(file.dayBoundary.gapAtBoundaryCount),
    formatPercent(file.interpolation.interpolatedPercent),
    String(file.completeness.qualityScore),
  ])

  console.log('-- Summary Table --')
  console.log(
    buildTable(['exchange', 'symbol', 'source', 'candles', 'days', 'boundary_gaps', 'interp%', 'score'], rows)
  )
  console.log('')
}

export function printValidationReport(report: QuoteValidationReport, reportPath: string): void {
  console.log('=== Quote Data Quality Validation Report ===')
  console.log(`Generated: ${report.generatedAt}`)
  console.log('')

  for (const file of report.files) {
    printFileBlock(file)
  }

  printCrossExchange(report)
  printSummaryTable(report)

  if (reportPath === '(stdout)') {
    console.log('Report emitted to stdout')
    return
  }

  const relativeReportPath = path.relative(process.cwd(), reportPath)
  console.log(
    `Report written to ${relativeReportPath.length > 0 && !relativeReportPath.startsWith('..') ? relativeReportPath : reportPath}`
  )
}
