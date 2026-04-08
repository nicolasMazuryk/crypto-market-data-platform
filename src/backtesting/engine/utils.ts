import { execSync } from 'child_process'

/** Get current git commit hash, or null if not in a git repo */
export function getGitCommit(): string | null {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}
