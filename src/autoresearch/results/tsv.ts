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
  'ulcer_index',
  'equity_curve_quality_score',
  'status',
  'description',
  'report_path',
  'duration_s',
  'error_message',
] as const

// Legacy header (12 columns, before equity curve metrics were added)
const LEGACY_HEADER = [
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
].join('\t')

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
    formatNumber(row.ulcer_index),
    formatNumber(row.equity_curve_quality_score),
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
  const isLegacy = header === LEGACY_HEADER
  if (header !== RESULTS_HEADER_LINE && !isLegacy) {
    throw new Error(`results.tsv header mismatch. Expected '${RESULTS_HEADER_LINE}', got '${header ?? ''}'`)
  }
  const expectedCols = isLegacy ? 12 : HEADER.length
  const rows: ResultRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const fields = line.split('\t')
    if (fields.length !== expectedCols) {
      throw new Error(
        `results.tsv line ${String(i + 1)}: expected ${String(expectedCols)} fields, got ${String(fields.length)}`
      )
    }

    let iter: string, timestamp: string, commit_hash: string, pnl: string, sharpe: string
    let win: string, trades: string, status: string, desc: string, report: string, dur: string, err: string
    let ulcer: string = '',
      ecq: string = ''

    if (isLegacy) {
      ;[iter, timestamp, commit_hash, pnl, sharpe, win, trades, status, desc, report, dur, err] = fields as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    } else {
      ;[iter, timestamp, commit_hash, pnl, sharpe, win, trades, ulcer, ecq, status, desc, report, dur, err] =
        fields as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
    }

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
      ulcer_index: parseNumber(ulcer),
      equity_curve_quality_score: parseNumber(ecq),
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
