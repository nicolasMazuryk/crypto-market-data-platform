import type { AgentKind } from '../types.js'
import { invokeClaude } from './claude.js'
import { invokeCodex } from './codex.js'

export interface InvokeAgentOptions {
  agent: AgentKind
  prompt: string
  cwd: string
  addDirs: string[]
  timeoutMs: number
  /** Claude-only */
  allowedTools?: string[]
  /** Claude-only */
  disallowedTools?: string[]
  /** Claude-only */
  claudeBinary?: string
  /** Codex-only */
  codexBinary?: string
  extraArgs?: string[]
  logWrite?: (line: string) => void
}

export interface InvokeAgentResult {
  code: number
  durationMs: number
  timedOut: boolean
  stdout: string
  stderr: string
  tokensUsed: number | null
  costUsd: number | null
}

export function invokeAgent(opts: InvokeAgentOptions): Promise<InvokeAgentResult> {
  if (opts.agent === 'codex') {
    return invokeCodex(opts)
  }
  return invokeClaude(opts)
}
