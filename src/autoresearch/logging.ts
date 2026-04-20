import fs from 'fs'
import path from 'path'
import pino from 'pino'

import { getLogPath } from './paths.js'

export type TagLogger = pino.Logger

export function createTagLogger(repoRoot: string, tag: string): TagLogger {
  const logPath = getLogPath(repoRoot, tag)
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const dest = pino.destination({ dest: logPath, mkdir: true, sync: false })
  return pino({ level: 'debug', base: { tag } }, dest)
}
