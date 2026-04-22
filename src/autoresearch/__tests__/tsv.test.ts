import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendRow, ensureTsv, parseTsvContent, readTsv, RESULTS_HEADER_LINE } from '../results/tsv.js'
import type { ResultRow } from '../types.js'

function makeRow(overrides: Partial<ResultRow> = {}): ResultRow {
  return {
    iter: 1,
    timestamp: '2026-04-18T00:00:00.000Z',
    commit_hash: 'abc123',
    total_net_pnl: 0.042,
    sharpe: 1.5,
    win_rate: 0.6,
    trades: 12,
    ulcer_index: 3.14,
    equity_curve_quality_score: 72.5,
    status: 'keep',
    description: 'bumped funding_threshold',
    report_path: '.autoresearch/reports/x/iter_1.json',
    duration_s: 12.3,
    error_message: '',
    ...overrides,
  }
}

describe('results tsv', () => {
  let dir: string
  let tsvPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-tsv-'))
    tsvPath = path.join(dir, 'results.tsv')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('ensureTsv creates header-only file', () => {
    ensureTsv(tsvPath)
    expect(fs.readFileSync(tsvPath, 'utf-8')).toBe(`${RESULTS_HEADER_LINE}\n`)
  })

  it('appendRow + readTsv roundtrips', () => {
    ensureTsv(tsvPath)
    const row = makeRow()
    appendRow(tsvPath, row)
    appendRow(tsvPath, makeRow({ iter: 2, status: 'discard', description: 'too aggressive' }))
    const parsed = readTsv(tsvPath)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toEqual(row)
    expect(parsed[1]?.status).toBe('discard')
  })

  it('escapes embedded tabs/newlines in free-text fields', () => {
    ensureTsv(tsvPath)
    appendRow(tsvPath, makeRow({ description: 'weird\tdesc\nwith breaks', error_message: 'err\twith\ttabs' }))
    const parsed = readTsv(tsvPath)
    expect(parsed[0]?.description).toBe('weird desc with breaks')
    expect(parsed[0]?.error_message).toBe('err with tabs')
  })

  it('parseTsvContent rejects mismatched header', () => {
    expect(() => parseTsvContent('wrong\theader\n')).toThrow(/header mismatch/i)
  })

  it('parseTsvContent accepts legacy 12-column format with null equity metrics', () => {
    const legacyHeader =
      'iter\ttimestamp\tcommit_hash\ttotal_net_pnl\tsharpe\twin_rate\ttrades\tstatus\tdescription\treport_path\tduration_s\terror_message'
    const legacyRow = '1\t2026-01-01T00:00:00Z\tabc\t0.1\t1.5\t0.6\t10\tkeep\tbaseline\treports/x.json\t5.0\t'
    const rows = parseTsvContent(`${legacyHeader}\n${legacyRow}\n`)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.ulcer_index).toBeNull()
    expect(rows[0]?.equity_curve_quality_score).toBeNull()
    expect(rows[0]?.total_net_pnl).toBeCloseTo(0.1)
  })

  it('treats empty numeric fields as null', () => {
    ensureTsv(tsvPath)
    appendRow(
      tsvPath,
      makeRow({
        iter: 3,
        total_net_pnl: null,
        sharpe: null,
        win_rate: null,
        trades: null,
        status: 'error',
        description: '',
        report_path: '',
        error_message: 'backtest_timeout',
      })
    )
    const parsed = readTsv(tsvPath)
    expect(parsed[0]?.total_net_pnl).toBeNull()
    expect(parsed[0]?.sharpe).toBeNull()
    expect(parsed[0]?.trades).toBeNull()
    expect(parsed[0]?.status).toBe('error')
  })
})
