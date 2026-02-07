import fs from 'fs'
import path from 'path'
import pino from 'pino'

import { config } from './config.js'

const isProduction = config.env === 'production'
const logsDir = 'logs'

// Create logs directory if it doesn't exist
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true })
}

// Create file streams
const combinedFileStream = pino.destination({
  dest: path.join(logsDir, 'combined.log'),
  mkdir: true,
})
const errorFileStream = pino.destination({
  dest: path.join(logsDir, 'error.log'),
  mkdir: true,
})

// Set up console transport
const consoleTransport = !isProduction
  ? pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        messageKey: 'message',
        singleLine: false,
      },
    })
  : undefined

// Configure multistream: console + file outputs
const streams = [
  { stream: combinedFileStream }, // All levels to combined.log
  { stream: errorFileStream, level: 'error' }, // Errors to error.log
]

if (consoleTransport) {
  streams.push({ stream: consoleTransport }) // Console in dev
}

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
  multistream,
)
