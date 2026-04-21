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

// Create logs directory if it doesn't exist
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true })
}

// Create file streams
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

// Set up console transport
// In development: use pino-pretty for colorized output
// In production: use stdout with JSON format (for CloudWatch)
const consoleTransport = !isProduction
  ? pino.transport({
      target: 'pino-pretty',
      options: {
        // Avoid ANSI in piped child output (autoresearch log files, CI) while
        // keeping colors for interactive terminals.
        colorize: process.stdout.isTTY === true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        messageKey: 'message',
        singleLine: false,
      },
    })
  : process.stdout // JSON logs to stdout in production for CloudWatch

// Configure multistream: console + file outputs
const streams: pino.StreamEntry[] = [
  { stream: combinedFileStream, level: 'trace' }, // All levels to combined.log
  { stream: warnFileStream, level: 'warn' }, // Warnings only to warn.log
  { stream: errorFileStream, level: 'error' }, // Errors and fatal to error.log
]

// Always add console output (pretty in dev, JSON to stdout in production)
streams.push({ stream: consoleTransport, level: 'trace' })

const multistream = pino.multistream(streams)

export const logger = pino(
  {
    level: config.logLevel,
    redact: {
      paths: ['*.token', '*.secret', '*.password'],
      remove: true,
    },
    messageKey: 'message',
  },
  multistream
)
