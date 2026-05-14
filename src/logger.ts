import fs from 'fs'
import path from 'path'
import pino from 'pino'

import { config } from './config.js'

const isProduction = config.env === 'production'
const logsDir = 'logs'

// Pino levels: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal
const PINO_LEVEL_WARN = 40
const PINO_LEVEL_ERROR = 50

/** Wraps a pino destination and only forwards log lines whose level passes the predicate */
function levelFilterStream(
  dest: pino.DestinationStream,
  predicate: (level: number) => boolean
): pino.DestinationStream {
  return {
    write(data: string) {
      try {
        const obj = JSON.parse(data.trim()) as { level?: number }
        if (typeof obj.level === 'number' && predicate(obj.level)) {
          dest.write(data)
        }
      } catch {
        dest.write(data)
      }
    },
  }
}

// In production: stdout only (Docker/journald captures it; no unbounded local files).
// In development: stdout (pino-pretty) + rotating file streams under logs/.
let streams: pino.StreamEntry[]
let _prettyTransport: ReturnType<typeof pino.transport> | undefined

if (isProduction) {
  // JSON logs to stdout in production for Docker/journald
  streams = [{ stream: process.stdout, level: 'trace' }]
} else {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }

  const combinedFileStream = pino.destination({
    dest: path.join(logsDir, 'combined.log'),
    mkdir: true,
  })
  const warnFileStream = levelFilterStream(
    pino.destination({
      dest: path.join(logsDir, 'warn.log'),
      mkdir: true,
    }),
    level => level === PINO_LEVEL_WARN
  )
  const errorFileStream = levelFilterStream(
    pino.destination({
      dest: path.join(logsDir, 'error.log'),
      mkdir: true,
    }),
    level => level >= PINO_LEVEL_ERROR
  )

  _prettyTransport = pino.transport({
    target: 'pino-pretty',
    options: {
      // Avoid ANSI in piped child output (autoresearch log files, CI) while
      // keeping colors for interactive terminals.
      colorize: process.stdout.isTTY,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
      messageKey: 'message',
      singleLine: false,
    },
  })

  streams = [
    { stream: combinedFileStream, level: 'trace' },
    { stream: warnFileStream, level: 'warn' },
    { stream: errorFileStream, level: 'error' },
    { stream: _prettyTransport, level: 'trace' },
  ]
}

/** Flush + close the pino-pretty worker thread so terminal output isn't lost on exit. */
export function closeLogger(): Promise<void> {
  const transport = _prettyTransport
  if (!transport) return Promise.resolve()
  return new Promise(resolve => {
    transport.end(() => {
      resolve()
    })
  })
}

const multistream = pino.multistream(streams)

export const logger = pino(
  {
    level: config.logLevel,
    redact: {
      paths: ['*.token', '*.secret', '*.password', '*.apiKey', '*.passphrase', '*.privateKey', '*.cookie'],
      remove: true,
    },
    messageKey: 'message',
  },
  multistream
)
