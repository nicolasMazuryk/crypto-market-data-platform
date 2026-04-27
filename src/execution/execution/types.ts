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

export type ExitReason = 'timed' | 'tp' | 'sl' | 'deadline' | 'kill_switch' | 'error'

export interface IntentState {
  intent: TradeIntent
  status: IntentStatus
  entryOrderId?: string
  entryExchangeOrderId?: string
  exitOrderIds?: string[]
  filledQty: number
  avgEntryPrice?: number
  avgExitPrice?: number
  exitReason?: ExitReason
  error?: { code: string; message: string; at: number }
  updatedAt: number
}

export interface ExecutionManager {
  submit(intent: TradeIntent): Promise<IntentState>
  cancelIntent(id: string): Promise<void>
  flattenAll(): Promise<void>
  get(intentId: string): IntentState | undefined
  onStateChange(listener: (state: IntentState) => void): Unsubscribe
  prewarmLeverage(exchange: Exchange, symbol: string, leverage: number): void
}

export interface PositionMonitor {
  arm(state: IntentState): void
  disarm(intentId: string): void
  onExitRequested(listener: (intentId: string, reason: ExitReason) => void): Unsubscribe
}
