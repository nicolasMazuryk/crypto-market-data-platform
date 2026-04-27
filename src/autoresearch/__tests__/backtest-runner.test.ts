import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import { runBacktest } from '../backtest/runner.js'

const originalPath = process.env.PATH

afterEach(() => {
  process.env.PATH = originalPath
})

describe('runBacktest', () => {
  it('retries transient ClickHouse connection failures', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-backtest-'))
    const binDir = path.join(tmp, 'bin')
    const reportsDir = path.join(tmp, 'reports')
    const attemptsPath = path.join(tmp, 'attempts.txt')
    fs.mkdirSync(binDir)
    fs.mkdirSync(reportsDir)

    const fakeNpx = path.join(binDir, 'npx')
    fs.writeFileSync(
      fakeNpx,
      `#!/usr/bin/env node
const fs = require('fs')
const attemptsPath = ${JSON.stringify(attemptsPath)}
const reportsDir = ${JSON.stringify(reportsDir)}
const attempts = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, 'utf8')) : 0
fs.writeFileSync(attemptsPath, String(attempts + 1))
if (attempts === 0) {
  console.error('connect ECONNREFUSED 127.0.0.1:18123')
  process.exit(1)
}
fs.writeFileSync(require('path').join(reportsDir, 'report.json'), '{}')
process.exit(0)
`
    )
    fs.chmodSync(fakeNpx, 0o755)
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

    const result = await runBacktest({
      cwd: tmp,
      strategy: 'strategy_1',
      reportsDir,
      timeoutMs: 5_000,
      maxAttempts: 2,
      retryDelayMs: 1,
    })

    expect(result.code).toBe(0)
    expect(fs.readFileSync(attemptsPath, 'utf8')).toBe('2')
    expect(result.reportPath).toBe(path.join(reportsDir, 'report.json'))
  })
})
