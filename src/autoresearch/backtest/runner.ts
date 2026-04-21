import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

export interface BacktestRunResult {
  code: number
  durationMs: number
  timedOut: boolean
  stdout: string
  stderr: string
  reportPath: string | null
}

export interface BacktestRunOptions {
  /** Worktree cwd where `tsx src/scripts/run-backtest.ts` should run. */
  cwd: string
  strategy: string
  /** Absolute path where new reports will be written (reports dir). */
  reportsDir: string
  timeoutMs: number
  logWrite?: (line: string) => void
}

function listJsonFiles(dir: string): Set<string> {
  if (!fs.existsSync(dir)) return new Set()
  return new Set(fs.readdirSync(dir).filter(f => f.endsWith('.json')))
}

/**
 * Run the existing `tsx src/scripts/run-backtest.ts --strategy <name>` in the
 * worktree. Kill the process group on timeout. Returns the newly-written
 * report file so the caller can parse it.
 */
export function runBacktest(opts: BacktestRunOptions): Promise<BacktestRunResult> {
  return new Promise(resolve => {
    const { cwd, strategy, reportsDir, timeoutMs, logWrite } = opts
    fs.mkdirSync(reportsDir, { recursive: true })
    const before = listJsonFiles(reportsDir)

    const started = Date.now()
    const proc = spawn(
      'npx',
      ['tsx', 'src/scripts/run-backtest.ts', '--strategy', strategy],
      {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        detached: true,
      }
    )

    let stdout = ''
    let stderr = ''
    let timedOut = false

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stdout += text
      if (logWrite !== undefined) logWrite(text)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stderr += text
      if (logWrite !== undefined) logWrite(text)
    })

    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (proc.pid !== undefined) {
          process.kill(-proc.pid, 'SIGKILL')
        }
      } catch {
        // proc may already be dead
      }
    }, timeoutMs)

    proc.on('close', (code: number | null) => {
      clearTimeout(timer)
      const after = listJsonFiles(reportsDir)
      let reportPath: string | null = null
      for (const name of after) {
        if (!before.has(name)) {
          reportPath = path.join(reportsDir, name)
          break
        }
      }
      resolve({
        code: code ?? -1,
        durationMs: Date.now() - started,
        timedOut,
        stdout,
        stderr,
        reportPath,
      })
    })

    proc.on('error', (err: Error) => {
      clearTimeout(timer)
      resolve({
        code: -1,
        durationMs: Date.now() - started,
        timedOut: false,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        reportPath: null,
      })
    })
  })
}
