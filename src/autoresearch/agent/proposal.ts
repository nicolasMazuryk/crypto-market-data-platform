import fs from 'fs'

export interface Proposal {
  rationale: string
  summary: string
}

export type SummaryValidation = { ok: true } | { ok: false; reason: string }

const PLACEHOLDER_SUMMARIES = new Set([
  'improved',
  'regressed',
  'keep',
  'discard',
  'error',
  'updated',
  'tweak',
  'tweaked',
  'change',
  'changed',
  'n/a',
  'none',
  'tbd',
  'placeholder',
])

export function validateProposalSummary(s: string): SummaryValidation {
  const trimmed = s.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'summary is empty' }
  if (!/[a-zA-Z0-9]/.test(trimmed)) return { ok: false, reason: 'summary contains no alphanumeric characters' }
  if (PLACEHOLDER_SUMMARIES.has(trimmed.toLowerCase())) {
    return { ok: false, reason: `summary is a placeholder word ("${trimmed}")` }
  }
  if (trimmed.length < 15) return { ok: false, reason: `summary too short (${String(trimmed.length)} chars, min 15)` }
  return { ok: true }
}

export interface ProposalReadResult {
  proposal: Proposal | null
  error: string | null
}

export function readProposal(proposalPath: string): Proposal | null {
  if (!fs.existsSync(proposalPath)) return null
  const content = fs.readFileSync(proposalPath, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`proposal.json: invalid JSON: ${msg}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`proposal.json must be a JSON object`)
  }
  const obj = parsed as Record<string, unknown>
  const rationale = typeof obj.rationale === 'string' ? obj.rationale : ''
  const summary = typeof obj.summary === 'string' ? obj.summary : ''
  return { rationale, summary }
}

export function readProposalSafe(proposalPath: string): ProposalReadResult {
  try {
    return { proposal: readProposal(proposalPath), error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { proposal: null, error: message }
  }
}

export function clearProposal(proposalPath: string): void {
  if (fs.existsSync(proposalPath)) {
    fs.unlinkSync(proposalPath)
  }
}
