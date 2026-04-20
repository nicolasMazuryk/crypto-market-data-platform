import fs from 'fs'
import path from 'path'

import type { IterationStatus, ResultRow } from '../types.js'

const HEADER = [
  'iter',
  'timestamp',
  'commit_hash',
  'total_net_pnl',
  'sharpe',
  'win_rate',
  'trades',
  'status',
  'description',
  'report_path',
  'duration_s',
  'error_message',
] as const

export const RESULTS_HEADER_LINE = HEADER.join('\t')

function escapeField(val: string): string {
  return val.replace(/[\t\r\n]/g, ' ')
}

function formatNumber(val: number | null): string {
  if (val === null) return ''
  if (!Number.isFinite(val)) return ''
  return String(val)
}

function formatRow(row: ResultRow): string {
  const fields = [
    String(row.iter),
    row.timestamp,
    row.commit_hash,
    formatNumber(row.total_net_pnl),
    formatNumber(row.sharpe),
    formatNumber(row.win_rate),
    row.trades === null ? '' : String(row.trades),
    row.status,
    escapeField(row.description),
    escapeField(row.report_path),
    formatNumber(row.duration_s),
    escapeField(row.error_message),
  ]
  return fields.join('\t')
}

export function ensureTsv(tsvPath: string): void {
  if (!fs.existsSync(tsvPath)) {
    fs.mkdirSync(path.dirname(tsvPath), { recursive: true })
    fs.writeFileSync(tsvPath, `${RESULTS_HEADER_LINE}\n`, { flag: 'wx' })
  }
}

/** Append a row atomically by writing then fsync-ing. */
export function appendRow(tsvPath: string, row: ResultRow): void {
  ensureTsv(tsvPath)
  const line = `${formatRow(row)}\n`
  const fd = fs.openSync(tsvPath, 'a')
  try {
    fs.writeSync(fd, line)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function parseNumber(val: string): number | null {
  if (val === '') return null
  const n = Number(val)
  return Number.isFinite(n) ? n : null
}

function parseStatus(val: string): IterationStatus {
  if (val === 'keep' || val === 'discard' || val === 'noop' || val === 'error') {
    return val
  }
  throw new Error(`Invalid status in results.tsv: '${val}'`)
}

export function parseTsvContent(content: string): ResultRow[] {
  const lines = content.split('\n').filter(line => line.length > 0)
  if (lines.length === 0) return []
  const header = lines[0]
  if (header !== RESULTS_HEADER_LINE) {
    throw new Error(`results.tsv header mismatch. Expected '${RESULTS_HEADER_LINE}', got '${header ?? ''}'`)
  }
  const rows: ResultRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const fields = line.split('\t')
    if (fields.length !== HEADER.length) {
      throw new Error(
        `results.tsv line ${String(i + 1)}: expected ${String(HEADER.length)} fields, got ${String(fields.length)}`
      )
    }
    const [iter, timestamp, commit_hash, pnl, sharpe, win, trades, status, desc, report, dur, err] = fields as [
      string, string, string, string, string, string, string, string, string, string, string, string,
    ]
    const iterNum = Number(iter)
    if (!Number.isInteger(iterNum) || iterNum < 0) {
      throw new Error(`results.tsv line ${String(i + 1)}: invalid iter '${iter}'`)
    }
    const tradesNum = trades === '' ? null : Number(trades)
    if (tradesNum !== null && (!Number.isInteger(tradesNum) || tradesNum < 0)) {
      throw new Error(`results.tsv line ${String(i + 1)}: invalid trades '${trades}'`)
    }
    rows.push({
      iter: iterNum,
      timestamp,
      commit_hash,
      total_net_pnl: parseNumber(pnl),
      sharpe: parseNumber(sharpe),
      win_rate: parseNumber(win),
      trades: tradesNum,
      status: parseStatus(status),
      description: desc,
      report_path: report,
      duration_s: parseNumber(dur) ?? 0,
      error_message: err,
    })
  }
  return rows
}

export function readTsv(tsvPath: string): ResultRow[] {
  if (!fs.existsSync(tsvPath)) return []
  const content = fs.readFileSync(tsvPath, 'utf-8')
  return parseTsvContent(content)
}
