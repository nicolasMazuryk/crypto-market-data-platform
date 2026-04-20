import fs from 'fs'

export interface Proposal {
  rationale: string
  summary: string
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

export function clearProposal(proposalPath: string): void {
  if (fs.existsSync(proposalPath)) {
    fs.unlinkSync(proposalPath)
  }
}
