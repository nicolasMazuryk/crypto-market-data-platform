import { spawn } from 'child_process'

import type { InvokeAgentOptions, InvokeAgentResult } from './invoke.js'

interface CodexTurnEvent {
  type?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  cost?: number
  total_cost?: number
}

function parseCodexUsage(stdout: string): { tokensUsed: number | null; costUsd: number | null } {
  let totalTokens = 0
  let costUsd: number | null = null
  let hasTokens = false
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed) as CodexTurnEvent
      if (event.usage !== undefined) {
        const {
          input_tokens = 0,
          output_tokens = 0,
          cache_creation_input_tokens = 0,
          cache_read_input_tokens = 0,
        } = event.usage
        totalTokens += input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens
        hasTokens = true
      }
      if (typeof event.total_cost === 'number') {
        costUsd = event.total_cost
      } else if (typeof event.cost === 'number') {
        costUsd = (costUsd ?? 0) + event.cost
      }
    } catch {
      // non-JSON line, skip
    }
  }
  return { tokensUsed: hasTokens ? totalTokens : null, costUsd }
}

/** Build the codex exec argument list (exported for testing). */
export function buildCodexArgs(opts: Pick<InvokeAgentOptions, 'cwd' | 'addDirs' | 'extraArgs' | 'prompt'>): string[] {
  const model = 'gpt-5.4'
  const reasoningEffort = 'medium'

  const args: string[] = [
    'exec',
    '-C',
    opts.cwd,
    '-s',
    'workspace-write',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--model',
    model,
    '-c',
    `model_reasoning_effort="${reasoningEffort}"`,
    '--json',
  ]
  for (const dir of opts.addDirs) {
    args.push('--add-dir', dir)
  }
  if (opts.extraArgs !== undefined) {
    args.push(...opts.extraArgs)
  }
  args.push(opts.prompt)
  return args
}

export function invokeCodex(opts: InvokeAgentOptions): Promise<InvokeAgentResult> {
  return new Promise(resolve => {
    const bin = opts.codexBinary ?? 'codex'
    const args = buildCodexArgs(opts)
    const started = Date.now()
    const proc = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stdout += text
      if (opts.logWrite !== undefined) opts.logWrite(text)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stderr += text
      if (opts.logWrite !== undefined) opts.logWrite(text)
    })

    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (proc.pid !== undefined) {
          process.kill(-proc.pid, 'SIGKILL')
        }
      } catch {
        // already dead
      }
    }, opts.timeoutMs)

    proc.on('close', (code: number | null) => {
      clearTimeout(timer)
      const { tokensUsed, costUsd } = parseCodexUsage(stdout)
      resolve({
        code: code ?? -1,
        durationMs: Date.now() - started,
        timedOut,
        stdout,
        stderr,
        tokensUsed,
        costUsd,
      })
    })

    proc.on('error', (err: Error) => {
      clearTimeout(timer)
      const { tokensUsed, costUsd } = parseCodexUsage(stdout)
      resolve({
        code: -1,
        durationMs: Date.now() - started,
        timedOut: false,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        tokensUsed,
        costUsd,
      })
    })
  })
}
