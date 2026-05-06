import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readProposalSafe, validateProposalSummary } from '../agent/proposal.js'

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

  it('returns null proposal (not error) when file does not exist', () => {
    const result = readProposalSafe(path.join(dir, 'nonexistent.json'))
    expect(result.error).toBeNull()
    expect(result.proposal).toBeNull()
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

describe('validateProposalSummary', () => {
  describe('rejects bad inputs', () => {
    it('empty string', () => {
      const r = validateProposalSummary('')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/empty/)
    })

    it('whitespace only', () => {
      const r = validateProposalSummary('   ')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/empty/)
    })

    it('placeholder word "improved"', () => {
      const r = validateProposalSummary('improved')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/placeholder/)
    })

    it('placeholder word "REGRESSED" (case insensitive)', () => {
      const r = validateProposalSummary('  REGRESSED ')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/placeholder/)
    })

    it('placeholder word "updated"', () => {
      const r = validateProposalSummary('updated')
      expect(r.ok).toBe(false)
    })

    it('single char "x"', () => {
      const r = validateProposalSummary('x')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/short/)
    })

    it('only punctuation', () => {
      const r = validateProposalSummary('---...')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/alphanumeric/)
    })

    it('fewer than 15 chars', () => {
      const r = validateProposalSummary('short change')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/short/)
    })
  })

  describe('accepts valid summaries', () => {
    it('canonical format', () => {
      expect(validateProposalSummary('funding_threshold 0.010 → 0.012 (deepen filter)').ok).toBe(true)
    })

    it('rationale style without arrow', () => {
      expect(validateProposalSummary('raise stop_loss from 0.5% to 0.8% to reduce premature exits').ok).toBe(true)
    })

    it('exactly 15 chars', () => {
      expect(validateProposalSummary('sl 0.01 → 0.02x').ok).toBe(true)
    })
  })
})
