import type { Exchange } from '../types/exchange.js'
import type { StrategyId } from '../strategies/types.js'

export type EngineMode = 'live' | 'dry_run' | 'drain_only' | 'halted'

export interface ExposureCap {
  scope: 'global' | { strategy: StrategyId } | { exchange: Exchange }
  maxConcurrentIntents: number
  maxNotionalUsd: number
}

export interface KillSwitchState {
  mode: EngineMode
  trippedAt?: number
  reason?: string
}

export interface KillSwitch {
  state(): KillSwitchState
  trip(reason: string): Promise<void>
  setMode(mode: EngineMode, reason?: string): Promise<void>
  flattenAll(): Promise<void>
  canPlaceOrder(exchange: Exchange, strategy: StrategyId): boolean
  /** Wire the flatten implementation after construction (breaks the manager ↔ kill-switch dependency cycle). */
  wireFlattener(fn: () => Promise<void>): void
}
