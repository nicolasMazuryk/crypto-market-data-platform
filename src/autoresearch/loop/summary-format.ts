import fs from 'fs'
import path from 'path'

import type { ResultRow } from '../types.js'

const BLOCK_RAMP = ' ▁▂▃▄▅▆▇█'
const DEFAULT_WIDTH = 144
const DEFAULT_HEIGHT = 3
const LABEL_WIDTH = 14

interface SparklineOpts {
  width?: number
  height?: number
}

/**
 * Render `values` as `height` stacked rows that together form one
 * coherent block chart (not `height` independent sparklines): each column
 * gets a single level in [0, height*8], and row `r` (0 = bottom) shows
 * `clamp(level - r*8, 0, 8)` of the ramp, so a tall column fills the
 * bottom rows solid and tapers off in whichever row its level tops out.
 */
export function renderSparkline(values: number[], opts: SparklineOpts = {}): string[] {
  const width = opts.width ?? DEFAULT_WIDTH
  const height = opts.height ?? DEFAULT_HEIGHT

  if (values.length === 0) return ['n/a']

  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return ['n/a']

  const bucketCount = Math.min(width, values.length)
  const levels: number[] = []
  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor((b * values.length) / bucketCount)
    const end = Math.max(start + 1, Math.floor(((b + 1) * values.length) / bucketCount))
    const slice = values.slice(start, end)
    const avg = slice.reduce((sum, v) => sum + v, 0) / slice.length
    const normalized = (avg - min) / (max - min)
    levels.push(Math.round(normalized * height * 8))
  }

  const rows: string[] = []
  for (let r = height - 1; r >= 0; r--) {
    let row = ''
    for (const level of levels) {
      const idx = Math.min(8, Math.max(0, level - r * 8))
      row += BLOCK_RAMP.charAt(idx)
    }
    rows.push(row)
  }
  return rows
}

/** Read the equity curve off the copied per-iteration BacktestReport JSON. */
export function readEquityCurve(repoRoot: string, reportPath: string): number[] | null {
  if (reportPath.length === 0) return null
  const absPath = path.isAbsolute(reportPath) ? reportPath : path.join(repoRoot, reportPath)
  try {
    if (!fs.existsSync(absPath)) return null
    const parsed: unknown = JSON.parse(fs.readFileSync(absPath, 'utf8'))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'equity_curve' in parsed &&
      Array.isArray((parsed as { equity_curve: unknown }).equity_curve)
    ) {
      return (parsed as { equity_curve: number[] }).equity_curve
    }
    return null
  } catch {
    return null
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 3)}...`
}

function fmtNum(value: number | null, decimals: number): string {
  return value === null ? 'n/a' : value.toFixed(decimals)
}

function fmtPct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

function fmtInt(value: number | null): string {
  return value === null ? 'n/a' : value.toLocaleString('en-US')
}

function fmtCost(value: number | null): string {
  return value === null ? 'n/a' : `$${value.toFixed(4)}`
}

function label(text: string): string {
  return text.padEnd(LABEL_WIDTH)
}

function statRow(pairs: [string, string][]): string {
  return pairs.map(([k, v]) => `${label(k)}${v}`).join('   ')
}

/** Build a human-readable, structurally-consistent block for one iteration. */
export function formatIterationSummary(
  row: ResultRow,
  ctx: { repoRoot: string; tag: string; iterations: number }
): string {
  const rule = '─'.repeat(66)
  const header = `${ctx.tag}   iter ${String(row.iter)}/${String(ctx.iterations)}   ${row.status.toUpperCase()}`

  const lines: string[] = [rule, header, rule]
  lines.push(`${label('description')}${truncate(row.description, 240)}`)
  lines.push(`${label('pnl')}${fmtNum(row.total_net_pnl, 4)}`)
  lines.push(
    statRow([
      ['sharpe', fmtNum(row.sharpe, 2)],
      ['win_rate', fmtPct(row.win_rate)],
      ['trades', fmtInt(row.trades)],
    ])
  )
  lines.push(
    statRow([
      ['duration', `${row.duration_s.toFixed(1)}s`],
      ['tokens', fmtInt(row.tokens_used)],
      ['cost', fmtCost(row.cost_usd)],
    ])
  )

  const equityCurve = readEquityCurve(ctx.repoRoot, row.report_path)
  const sparkRows = renderSparkline(equityCurve ?? [])
  sparkRows.forEach((sparkRow, i) => {
    lines.push(`${i === 0 ? label('equity') : ' '.repeat(LABEL_WIDTH)}${sparkRow}`)
  })

  if (row.error_message.length > 0) {
    lines.push(`${label('error')}${truncate(row.error_message, 300)}`)
  }
  lines.push(rule)

  return lines.join('\n')
}
