import { spawn } from 'child_process'

import type { InvokeAgentOptions, InvokeAgentResult } from './invoke.js'

interface ClaudeResultEvent {
  type: string
  total_cost_usd?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

function parseClaudeUsage(stdout: string): { tokensUsed: number | null; costUsd: number | null } {
  let tokensUsed: number | null = null
  let costUsd: number | null = null
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = JSON.parse(trimmed) as ClaudeResultEvent
      if (event.type === 'result') {
        if (typeof event.total_cost_usd === 'number') costUsd = event.total_cost_usd
        if (event.usage !== undefined) {
          const { input_tokens = 0, output_tokens = 0, cache_creation_input_tokens = 0, cache_read_input_tokens = 0 } =
            event.usage
          tokensUsed = input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens
        }
      }
    } catch {
      // non-JSON line, skip
    }
  }
  return { tokensUsed, costUsd }
}

export function invokeClaude(opts: InvokeAgentOptions): Promise<InvokeAgentResult> {
  return new Promise(resolve => {
    const bin = opts.claudeBinary ?? 'claude'
    const model = 'haiku'
    const allowedTools = opts.allowedTools ?? [
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'Bash(cat:*)',
      'Bash(head:*)',
      'Bash(tail:*)',
      'Bash(ls:*)',
      'Bash(grep:*)',
      'Bash(rg:*)',
      'Bash(wc:*)',
      'Bash(find:*)',
      'Bash(curl:*)',
      'Bash(ssh:*)',
      'Bash(npm:run remote:clickhouse:query*)',
      'Bash(terraform:output*)',
    ]
    const disallowedTools = opts.disallowedTools ?? []

    const args: string[] = [
      '-p',
      opts.prompt,
      '--model',
      model,
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      allowedTools.join(' '),
      '--output-format',
      'stream-json',
      '--verbose',
    ]
    if (disallowedTools.length > 0) {
      args.push('--disallowedTools', disallowedTools.join(' '))
    }
    for (const dir of opts.addDirs) {
      args.push('--add-dir', dir)
    }
    if (opts.extraArgs !== undefined) {
      args.push(...opts.extraArgs)
    }

    const started = Date.now()
    const proc = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      detached: true,
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
      const { tokensUsed, costUsd } = parseClaudeUsage(stdout)
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
      const { tokensUsed, costUsd } = parseClaudeUsage(stdout)
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
