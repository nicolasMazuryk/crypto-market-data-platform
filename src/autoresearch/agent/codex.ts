import { spawn } from 'child_process'

import type { InvokeAgentOptions, InvokeAgentResult } from './invoke.js'

export function invokeCodex(opts: InvokeAgentOptions): Promise<InvokeAgentResult> {
  return new Promise(resolve => {
    const bin = opts.codexBinary ?? 'codex'
    const model = 'gpt-5.4-mini'
    const effort = 'medium'

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
      '--effort',
      effort,
    ]
    for (const dir of opts.addDirs) {
      args.push('--add-dir', dir)
    }
    if (opts.extraArgs !== undefined) {
      args.push(...opts.extraArgs)
    }
    args.push(opts.prompt)

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
      resolve({
        code: code ?? -1,
        durationMs: Date.now() - started,
        timedOut,
        stdout,
        stderr,
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
      })
    })
  })
}
