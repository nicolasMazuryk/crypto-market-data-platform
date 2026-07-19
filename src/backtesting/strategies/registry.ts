import type { StrategyId } from '../config/schema.js'
import type { BaseStrategy } from './types.js'
import { Strategy1 } from './strategy-1.js'
import { Strategy2 } from './strategy-2.js'
import { Strategy3 } from './strategy-3.js'
import { Strategy41 } from './strategy-4-1.js'
import { Strategy42 } from './strategy-4-2.js'
import { Strategy43 } from './strategy-4-3.js'
import { Strategy5 } from './strategy-5.js'

/** Create a strategy instance by ID */
export function createStrategy(id: StrategyId): BaseStrategy {
  // strategy_6 is live-only: MAIN entry depends on receiving ws.funding_fee in real-time.
  if ((id as string) === 'strategy_6') {
    throw new Error('strategy_6 is live-only; backtest mode cannot emulate WS funding-fee events')
  }

  switch (id) {
    case 'strategy_1':
      return new Strategy1()
    case 'strategy_2':
      return new Strategy2()
    case 'strategy_3a':
      return new Strategy3('strategy_3a')
    case 'strategy_3b':
      return new Strategy3('strategy_3b')
    case 'strategy_4_1a':
      return new Strategy41('strategy_4_1a')
    case 'strategy_4_2a':
      return new Strategy42('strategy_4_2a')
    case 'strategy_4_3a':
      return new Strategy43('strategy_4_3a')
    case 'strategy_5':
      return new Strategy5()
  }
}
