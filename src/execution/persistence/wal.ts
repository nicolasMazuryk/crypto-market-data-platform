import { appendFileSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import type { Logger } from 'pino'

export interface WalEntry {
  table: string
  row: Record<string, unknown>
  onConflict?: 'ignore' | 'update'
}

export interface WalHandle {
  append(entry: WalEntry): void
  /** Read entries without clearing the WAL file. */
  peek(): WalEntry[]
  /** Atomically replace WAL content with the given entries (use after successful DB write). */
  rewrite(entries: WalEntry[]): void
  /** @deprecated Use peek() + rewrite() for atomic drain. */
  drain(): WalEntry[]
  size(): number
}

export function createWal(walPath: string, logger: Logger, maxBytes = 50 * 1024 * 1024): WalHandle {
  return {
    append(entry: WalEntry): void {
      try {
        if (existsSync(walPath)) {
          const stat = statSync(walPath)
          if (stat.size >= maxBytes) {
            logger.warn({ walPath, size: stat.size }, 'wal: max size reached, dropping entry')
            return
          }
        }
        appendFileSync(walPath, JSON.stringify(entry) + '\n', 'utf8')
      } catch (err) {
        logger.error({ err, walPath }, 'wal: append failed')
      }
    },

    peek(): WalEntry[] {
      if (!existsSync(walPath)) return []
      try {
        const content = readFileSync(walPath, 'utf8')
        const lines = content.split('\n').filter(l => l.trim() !== '')
        const entries: WalEntry[] = []
        const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
        for (const line of lines) {
          try {
            entries.push(
              JSON.parse(line, (_key, value: unknown) => {
                if (typeof value === 'string' && ISO_RE.test(value)) {
                  const d = new Date(value)
                  if (!isNaN(d.getTime())) return d
                }
                return value
              }) as WalEntry
            )
          } catch {
            logger.warn({ line }, 'wal: skipping malformed line')
          }
        }
        return entries
      } catch (err) {
        logger.error({ err, walPath }, 'wal: peek failed')
        return []
      }
    },

    rewrite(entries: WalEntry[]): void {
      try {
        if (entries.length === 0) {
          writeFileSync(walPath, '', 'utf8')
        } else {
          writeFileSync(walPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')
        }
      } catch (err) {
        logger.error({ err, walPath }, 'wal: rewrite failed')
      }
    },

    drain(): WalEntry[] {
      if (!existsSync(walPath)) return []
      try {
        const content = readFileSync(walPath, 'utf8')
        const lines = content.split('\n').filter(l => l.trim() !== '')
        const entries: WalEntry[] = []
        for (const line of lines) {
          try {
            entries.push(JSON.parse(line) as WalEntry)
          } catch {
            logger.warn({ line }, 'wal: skipping malformed line')
          }
        }
        writeFileSync(walPath, '', 'utf8')
        return entries
      } catch (err) {
        logger.error({ err, walPath }, 'wal: drain failed')
        return []
      }
    },

    size(): number {
      if (!existsSync(walPath)) return 0
      try {
        return statSync(walPath).size
      } catch {
        return 0
      }
    },
  }
}
