import type { Logger } from 'pino'
import type { ConnectionState } from '../adapters/privatews/types.js'
import type { ExitReason } from '../execution/types.js'

export function logWsConnection(
  logger: Logger,
  fields: {
    exchange: string
    state: ConnectionState
    prevState: ConnectionState | 'idle' | null
    downtimeMs: number | null
    reason?: string
  }
): void {
  logger.info({ event: 'ws.connection', ...fields }, 'ws.connection')
}

export function logOcoCancelAttempt(
  logger: Logger,
  fields: {
    intentId: string
    exitOrderClientId: string | undefined
    exitKind: string
    strategy: 'A' | 'B' | 'C'
    exchange: string
    symbol: string
  }
): void {
  logger.info({ event: 'oco.cancel.attempt', ...fields }, 'oco.cancel.attempt')
}

export function logOcoCancelComplete(
  logger: Logger,
  fields: {
    intentId: string
    exitOrderClientId: string | undefined
    outcome: 'cancelled' | 'not_open' | 'failed'
    attempts: number
    totalDurationMs: number
    exchange: string
    symbol: string
  }
): void {
  logger.info({ event: 'oco.cancel.complete', ...fields }, 'oco.cancel.complete')
}

export function logOcoSweepComplete(
  logger: Logger,
  fields: {
    intentId: string
    exchange: string
    symbol: string
    foundCount: number
    cancelledCount: number
    failedCount: number
    foundOrderIds: (string | undefined)[]
  }
): void {
  logger.info({ event: 'oco.sweep.complete', ...fields }, 'oco.sweep.complete')
}

export function logPollingExhausted(
  logger: Logger,
  fields: {
    intentId: string
    kind: string
    attempts: number
    durationMs: number
    lastErrorCode?: string
  }
): void {
  logger.warn({ event: 'polling.exhausted', ...fields }, 'polling.exhausted')
}

export function logPreflightRejected(
  logger: Logger,
  fields: {
    exchange: string
    strategy: string
    symbol: string
    rejectionCode: string
    rejectionText: string
  }
): void {
  logger.warn({ event: 'preflight.rejected', ...fields }, 'preflight.rejected')
}

export function logFundingGateOpened(
  logger: Logger,
  fields: { intentId: string; openedAt: number; fundingTs: number }
): void {
  logger.info({ event: 'intent.funding_gate_opened', ...fields }, 'intent.funding_gate_opened')
}

export function logFundingGateClosed(
  logger: Logger,
  fields: {
    intentId: string
    openedAt: number
    closedAt: number
    durationMs: number
    reason: ExitReason | 'error' | 'unknown'
  }
): void {
  logger.info({ event: 'intent.funding_gate_closed', ...fields }, 'intent.funding_gate_closed')
}

export function logFillUnmatched(
  logger: Logger,
  fields: {
    exchange: string
    symbol: string
    clientOrderId: string
    exchangeFillId: string
    rawFill?: unknown
    reason: string
  }
): void {
  logger.warn({ event: 'fill.unmatched', ...fields }, 'fill.unmatched')
}

export function logWalDiscarded(
  logger: Logger,
  fields: {
    table: string
    pgErrorCode: string
    pgErrorText: string
    payload?: unknown
  }
): void {
  logger.warn({ event: 'persistence.wal.discarded', ...fields }, 'persistence.wal.discarded')
}
