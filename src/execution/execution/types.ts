import type { Exchange, Unsubscribe } from '../types/exchange.js'
import type { TradeIntent } from '../strategies/types.js'

export type IntentStatus =
  | 'decided'
  | 'submitted'
  | 'acked'
  | 'working'
  | 'partially_filled'
  | 'filled'
  | 'monitoring'
  | 'exiting'
  | 'exited'
  | 'error'
  | 'cancelled'

export type { ExitReason } from '../../config/canonical/enums.js'
import type { ExitReason } from '../../config/canonical/enums.js'

/**
 * `exitReason`/metric channel type: the §12.1 canonical reasons plus the non-canonical
 * `'error'` sentinel emitted on the abnormal terminal path (e.g. retracement TP exhausted
 * on an open position). `'error'` is intentionally NOT a member of the canonical `ExitReason`
 * registry so §12.1 distributions stay clean. Matches `log-events.ts` `ExitReason | 'error'`.
 */
export type TerminalMarker = ExitReason | 'error'

export interface ExitOrderRef {
  clientOrderId: string
  exchangeOrderId?: string
}

export interface LadderRung {
  clientOrderId: string
  /** Canonical (exchange-normalised) clientOrderId used as map key. */
  canonicalId: string
  qtyFraction: number
  filled: boolean
  filledQty: number
  avgFillPrice: number
}

export interface IntentState {
  intent: TradeIntent
  status: IntentStatus
  entryOrderId?: string
  entryExchangeOrderId?: string
  preFundingOrderId?: string
  preFundingExchangeOrderId?: string
  preFundingFilledQty?: number
  preFundingAvgFillPrice?: number
  preFundingFilledEmitted?: boolean
  preFundingFilledAt?: number
  exitOrderRefs?: { sl?: ExitOrderRef; tp?: ExitOrderRef; close?: ExitOrderRef }
  filledQty: number
  avgEntryPrice?: number
  avgExitPrice?: number
  exitReason?: TerminalMarker
  error?: { code: string; message: string; at: number }
  oco?: { bothFilled?: boolean }
  updatedAt: number
  /** Present for ladder_limit intents: per-rung fill tracking. */
  ladderRungs?: LadderRung[]
  /** True once the funding gate has opened in spawnRetracementTracker. Persisted for restart re-arm. */
  fundingGateOpen?: boolean
  /** Incremented each time the close-placement branch is entered in handleMonitorExit. */
  closeAttemptCount?: number
  /** Present for single limit_limit entries (R11): P_limit for SL anchoring. */
  entryLimitPrice?: number
}

export interface ExecutionManager {
  submit(intent: TradeIntent): Promise<IntentState>
  cancelIntent(id: string): Promise<void>
  flattenAll(): Promise<void>
  get(intentId: string): IntentState | undefined
  onStateChange(listener: (state: IntentState) => void): Unsubscribe
  prewarmLeverage(exchange: Exchange, symbol: string, leverage: number): Promise<void>
  listOpenIntents(): { intentId: string; exchange: Exchange; symbol: string }[]
  listRecentIntentsForAttribution(maxAgeMs: number): { intentId: string; exchange: Exchange; symbol: string }[]
}

export interface PositionMonitor {
  arm(state: IntentState): void
  disarm(intentId: string): void
  onExitRequested(listener: (intentId: string, reason: ExitReason) => void): Unsubscribe
}
