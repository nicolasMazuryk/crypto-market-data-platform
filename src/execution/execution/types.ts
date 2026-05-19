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

export type ExitReason =
  | 'timed'
  | 'tp'
  | 'sl'
  | 'deadline'
  | 'kill_switch'
  | 'error'
  | 'funding_fee'
  | 'funding_fee_timeout'

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
  exitReason?: ExitReason
  error?: { code: string; message: string; at: number }
  oco?: { bothFilled?: boolean }
  updatedAt: number
  /** Present for ladder_limit intents: per-rung fill tracking. */
  ladderRungs?: LadderRung[]
  /** True once the funding gate has opened in spawnRetracementTracker. Persisted for restart re-arm. */
  fundingGateOpen?: boolean
  /** Incremented each time the close-placement branch is entered in handleMonitorExit. */
  closeAttemptCount?: number
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
