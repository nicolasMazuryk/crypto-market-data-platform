import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readProposalSafe } from '../agent/proposal.js'

describe('readProposalSafe', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-proposal-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns a parse error instead of throwing on malformed json', () => {
    const proposalPath = path.join(dir, 'proposal.json')
    fs.writeFileSync(proposalPath, '{"summary":"ok"} trailing')

    const result = readProposalSafe(proposalPath)
    expect(result.proposal).toBeNull()
    expect(result.error).toContain('proposal.json: invalid JSON')
  })

  it('returns parsed proposal when json is valid', () => {
    const proposalPath = path.join(dir, 'proposal.json')
    fs.writeFileSync(
      proposalPath,
      JSON.stringify({
        rationale: 'test rationale',
        summary: 'short summary',
      })
    )

    const result = readProposalSafe(proposalPath)
    expect(result.error).toBeNull()
    expect(result.proposal).toEqual({
      rationale: 'test rationale',
      summary: 'short summary',
    })
  })
})
