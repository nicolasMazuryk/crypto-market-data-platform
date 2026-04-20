import fs from 'fs'
import path from 'path'

import { writeDashboard } from './dashboard.js'
import { runController } from './loop/controller.js'
import { Semaphore } from './loop/pool.js'
import { loadMatrix, toRunSpec } from './matrix/loader.js'
import { tagForRow } from './paths.js'
import { removeWorktree } from './worktree/manager.js'
import type { MatrixFile, MatrixRow, RunSpec } from './types.js'

interface CliArgs {
  matrixPath: string
  programMdPath: string
  runs: string[] | null
  baselineOnly: boolean
  reset: boolean
  list: boolean
  dashboard: boolean
}

function parseCli(argv: string[]): CliArgs {
  let matrixPath = 'autoresearch/matrix.yaml'
  let programMdPath = 'autoresearch/program.md'
  let runs: string[] | null = null
  let baselineOnly = false
  let reset = false
  let list = false
  let dashboard = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--matrix' && argv[i + 1] !== undefined) {
      matrixPath = argv[i + 1] ?? matrixPath
      i++
    } else if (arg === '--program' && argv[i + 1] !== undefined) {
      programMdPath = argv[i + 1] ?? programMdPath
      i++
    } else if (arg === '--run') {
      const val = argv[i + 1]
      if (val === undefined) {
        throw new Error(`--run requires a tag argument`)
      }
      runs = runs === null ? [val] : [...runs, val]
      i++
    } else if (arg === '--baseline-only') {
      baselineOnly = true
    } else if (arg === '--reset') {
      reset = true
    } else if (arg === '--list') {
      list = true
    } else if (arg === '--dashboard') {
      dashboard = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  return { matrixPath, programMdPath, runs, baselineOnly, reset, list, dashboard }
}

function printHelp(): void {
  const lines = [
    'Usage: tsx src/autoresearch/orchestrate.ts [flags]',
    '',
    'Flags:',
    '  --matrix <path>       Path to matrix.yaml (default: autoresearch/matrix.yaml)',
    '  --program <path>      Path to program.md (default: autoresearch/program.md)',
    '  --run <tag>           Run only the given tag (repeatable). Default: run all.',
    '  --baseline-only       Run iter 0 only for each selected tag',
    '  --reset               Delete worktree + results state for selected tags first',
    '  --list                List matrix tags and exit',
    '  --dashboard           Rebuild .autoresearch/dashboard.json and exit',
  ]
  console.log(lines.join('\n'))
}

function resolveRepoRoot(): string {
  return process.cwd()
}

async function resetRunState(repoRoot: string, tag: string): Promise<void> {
  await removeWorktree(repoRoot, tag)
  const resultsDir = path.join(repoRoot, '.autoresearch', 'results', tag)
  if (fs.existsSync(resultsDir)) {
    fs.rmSync(resultsDir, { recursive: true, force: true })
  }
  const reportsDir = path.join(repoRoot, '.autoresearch', 'reports', tag)
  if (fs.existsSync(reportsDir)) {
    fs.rmSync(reportsDir, { recursive: true, force: true })
  }
  const logPath = path.join(repoRoot, '.autoresearch', 'logs', `${tag}.log`)
  if (fs.existsSync(logPath)) {
    fs.rmSync(logPath, { force: true })
  }
}

function selectRuns(matrix: MatrixFile, runs: string[] | null): { row: MatrixRow; spec: RunSpec }[] {
  const byTag = new Map<string, MatrixRow>()
  for (const row of matrix.runs) {
    byTag.set(tagForRow(row), row)
  }
  const selectedTags = runs ?? [...byTag.keys()]
  const out: { row: MatrixRow; spec: RunSpec }[] = []
  for (const tag of selectedTags) {
    const row = byTag.get(tag)
    if (row === undefined) {
      throw new Error(`Tag '${tag}' is not in matrix`)
    }
    out.push({ row, spec: toRunSpec(row, matrix) })
  }
  return out
}

async function runWithPools(
  repoRoot: string,
  specs: RunSpec[],
  matrix: MatrixFile,
  programMdPath: string,
  baselineOnly: boolean,
  reset: boolean
): Promise<void> {
  const chSemaphore = new Semaphore(matrix.max_parallel_backtests)
  const runSemaphore = new Semaphore(matrix.max_parallel)

  const abortController = new AbortController()
  const sigintHandler = (): void => {
    if (!abortController.signal.aborted) {
      console.error('\n[autoresearch] SIGINT received; finishing current iterations then stopping')
      abortController.abort()
    }
  }
  process.on('SIGINT', sigintHandler)
  process.on('SIGTERM', sigintHandler)

  try {
    const tasks = specs.map(spec =>
      runSemaphore.withLease(async () => {
        if (reset) {
          await resetRunState(repoRoot, spec.tag)
        }
        const result = await runController({
          repoRoot,
          spec,
          programMdPath,
          chSemaphore,
          baselineOnly,
          abortSignal: abortController.signal,
        })
        console.log(
          `[autoresearch] ${spec.tag}: status=${result.status} ` +
            `iterations=${String(result.iterations)} best_pnl=${
              result.bestPnl === null ? 'n/a' : result.bestPnl.toFixed(6)
            }`
        )
      })
    )
    await Promise.all(tasks)
  } finally {
    process.off('SIGINT', sigintHandler)
    process.off('SIGTERM', sigintHandler)
  }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  const repoRoot = resolveRepoRoot()
  const matrixPath = path.resolve(repoRoot, cli.matrixPath)
  const programMdPath = path.resolve(repoRoot, cli.programMdPath)

  if (cli.dashboard) {
    const outPath = writeDashboard(repoRoot)
    console.log(`Wrote ${outPath}`)
    return
  }

  const matrix = loadMatrix(matrixPath)
  if (cli.list) {
    for (const row of matrix.runs) {
      const spec = toRunSpec(row, matrix)
      console.log(`${spec.tag}\titerations=${String(spec.iterations)}`)
    }
    return
  }

  const selected = selectRuns(matrix, cli.runs)
  const specs = selected.map(entry => entry.spec)

  if (specs.length === 0) {
    console.error('No runs selected')
    process.exit(1)
  }

  await runWithPools(repoRoot, specs, matrix, programMdPath, cli.baselineOnly, cli.reset)
  writeDashboard(repoRoot)
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err)
  console.error(`[autoresearch] fatal: ${message}`)
  process.exit(1)
})
