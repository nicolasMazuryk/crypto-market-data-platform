import type { Logger } from 'pino'

import { logger as rootLogger } from '../../logger.js'

export interface ExecutionLogger extends Logger {
  childFor(name: string, extra?: Record<string, unknown>): Logger
  childForIntent(intentId: string, strategy: string, exchange: string): Logger
}

export function createExecutionLogger(): ExecutionLogger {
  const base = rootLogger.child({ module: 'execution' }) as ExecutionLogger
  base.childFor = (name: string, extra: Record<string, unknown> = {}) => base.child({ component: name, ...extra })
  base.childForIntent = (intentId: string, strategy: string, exchange: string) =>
    base.child({ intentId, strategy_id: strategy, exchange })
  return base
}
