import fs from 'fs'
import path from 'path'
import lockfile from 'proper-lockfile'

export interface LockHandle {
  release: () => Promise<void>
}

/**
 * Acquire an exclusive lock for a tag. The lock target must exist — we touch
 * the file first so proper-lockfile can hang a `.lock` marker next to it.
 */
export async function acquireLock(lockPath: string): Promise<LockHandle> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  if (!fs.existsSync(lockPath)) {
    fs.writeFileSync(lockPath, '')
  }
  const release = await lockfile.lock(lockPath, {
    retries: { retries: 5, minTimeout: 200, maxTimeout: 2_000, factor: 1.5 },
    stale: 60_000,
  })
  return {
    release: async () => {
      await release()
    },
  }
}

export async function isLocked(lockPath: string): Promise<boolean> {
  if (!fs.existsSync(lockPath)) return false
  return lockfile.check(lockPath)
}
