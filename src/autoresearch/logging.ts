import fs from 'fs'
import path from 'path'
import pino from 'pino'
import pinoPretty from 'pino-pretty'

import { getLogPath } from './paths.js'

export type TagLogger = pino.Logger

/** Remove ANSI escapes so `.autoresearch/logs/*.log` stays readable in editors. */
export function stripAnsi(text: string): string {
  // CSI + OSC sequences and single-byte escapes (common terminal styling)
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g, '')
}

export function createTagLogger(repoRoot: string, tag: string): TagLogger {
  const logPath = getLogPath(repoRoot, tag)
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const fileStream = fs.createWriteStream(logPath, { flags: 'w' })
  const pretty = pinoPretty({
    colorize: false,
    translateTime: 'SYS:standard',
    ignore: 'pid,hostname',
    messageKey: 'message',
    singleLine: false,
  })
  pretty.pipe(fileStream)
  return pino({ level: 'debug', base: { tag }, messageKey: 'message' }, pretty)
}
