import { describe, expect, it } from 'vitest'

import { buildCodexArgs } from '../agent/codex.js'

describe('buildCodexArgs', () => {
  const base = {
    cwd: '/some/worktree',
    addDirs: [] as string[],
    prompt: 'do something',
  }

  it('does not include the obsolete --effort flag', () => {
    const args = buildCodexArgs(base)
    expect(args).not.toContain('--effort')
  })

  it('passes model_reasoning_effort via -c config override', () => {
    const args = buildCodexArgs(base)
    const idx = args.indexOf('-c')
    expect(idx).toBeGreaterThanOrEqual(0)
    const configValue = args[idx + 1]
    expect(configValue).toMatch(/^model_reasoning_effort=/)
  })

  it('includes workspace-write sandbox and expected flags', () => {
    const args = buildCodexArgs(base)
    expect(args).toContain('exec')
    expect(args).toContain('-s')
    expect(args[args.indexOf('-s') + 1]).toBe('workspace-write')
    expect(args).toContain('--skip-git-repo-check')
    expect(args).toContain('--model')
  })

  it('appends the prompt as the last positional argument', () => {
    const args = buildCodexArgs(base)
    expect(args[args.length - 1]).toBe('do something')
  })

  it('adds --add-dir entries for each extra directory', () => {
    const args = buildCodexArgs({ ...base, addDirs: ['/dir/a', '/dir/b'] as string[] })
    const addDirIndices = args.reduce<number[]>((acc, v, i) => (v === '--add-dir' ? [...acc, i] : acc), [])
    expect(addDirIndices).toHaveLength(2)
    expect(args[addDirIndices[0]! + 1]).toBe('/dir/a')
    expect(args[addDirIndices[1]! + 1]).toBe('/dir/b')
  })

  it('appends extraArgs before the prompt', () => {
    const args = buildCodexArgs({ ...base, extraArgs: ['--json'] as string[], prompt: 'p' })
    const jsonIdx = args.indexOf('--json')
    const promptIdx = args.indexOf('p')
    expect(jsonIdx).toBeGreaterThanOrEqual(0)
    expect(jsonIdx).toBeLessThan(promptIdx)
  })
})
