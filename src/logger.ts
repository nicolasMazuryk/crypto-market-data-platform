import pino from 'pino'

import { config } from './config.js'

const isProduction = config.env === 'production'

const transport = !isProduction
  ? pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        singleLine: false,
      },
    })
  : undefined

export const logger = pino(
  {
    level: config.logLevel,
    redact: {
      paths: ['*.token', '*.secret', '*.password'],
      remove: true,
    },
    messageKey: 'message',
  },
  transport,
)
