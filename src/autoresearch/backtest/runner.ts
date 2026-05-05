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
  maxAttempts?: number
  retryDelayMs?: number
}

const DEFAULT_MAX_ATTEMPTS = 3
// 15 s gives the SSH tunnel supervisor (2 s backoff + SSH handshake + possible
// first-reconnect failure + 4 s second backoff + handshake) enough time to
// re-establish the port forward before we retry the backtest.
const DEFAULT_RETRY_DELAY_MS = 15_000
const RETRYABLE_FAILURE_PATTERNS = [/\bECONNREFUSED\b/i, /\bECONNRESET\b/i, /\bETIMEDOUT\b/i, /\bsocket hang up\b/i]

function listJsonFiles(dir: string): Set<string> {
  if (!fs.existsSync(dir)) return new Set()
  return new Set(fs.readdirSync(dir).filter(f => f.endsWith('.json')))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function isRetryableBacktestFailure(
  result: Pick<BacktestRunResult, 'code' | 'timedOut' | 'stdout' | 'stderr'>
): boolean {
  if (result.code === 0 || result.timedOut) return false
  const output = `${result.stderr}\n${result.stdout}`
  return RETRYABLE_FAILURE_PATTERNS.some(pattern => pattern.test(output))
}

/**
 * Run the existing `tsx src/scripts/run-backtest.ts --strategy <name>` in the
 * worktree. Kill the process group on timeout. Returns the newly-written
 * report file so the caller can parse it.
 */
export async function runBacktest(opts: BacktestRunOptions): Promise<BacktestRunResult> {
  const started = Date.now()
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runBacktestAttempt(opts)
    if (!isRetryableBacktestFailure(result) || attempt === maxAttempts) {
      return { ...result, durationMs: Date.now() - started }
    }

    opts.logWrite?.(
      `[backtest] transient failure on attempt ${String(attempt)} of ${String(maxAttempts)}; retrying in ${String(
        retryDelayMs
      )}ms\n`
    )
    await sleep(retryDelayMs)
  }

  throw new Error('unreachable backtest retry state')
}

function runBacktestAttempt(opts: BacktestRunOptions): Promise<BacktestRunResult> {
  return new Promise(resolve => {
    const { cwd, strategy, reportsDir, timeoutMs, logWrite } = opts
    fs.mkdirSync(reportsDir, { recursive: true })
    const before = listJsonFiles(reportsDir)

    const started = Date.now()
    const proc = spawn('npx', ['tsx', 'src/scripts/run-backtest.ts', '--strategy', strategy], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      detached: true,
    })

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
