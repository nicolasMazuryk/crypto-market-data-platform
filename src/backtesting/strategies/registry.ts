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
    case 'strategy_4_1b':
      return new Strategy41('strategy_4_1b')
    case 'strategy_4_2a':
      return new Strategy42('strategy_4_2a')
    case 'strategy_4_2b':
      return new Strategy42('strategy_4_2b')
    case 'strategy_4_3a':
      return new Strategy43('strategy_4_3a')
    case 'strategy_4_3b':
      return new Strategy43('strategy_4_3b')
    case 'strategy_5':
      return new Strategy5()
  }
}
