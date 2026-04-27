import type { Exchange } from '../types/exchange.js'
import type { StrategyId, TradeIntent } from '../strategies/types.js'
import type { MarketMetadataProvider } from '../markets/types.js'
import type { StateStore } from '../state/types.js'
import type { KillSwitch } from '../risk/types.js'
import type { RiskConfig } from '../config/types.js'
import { computeOrderQty } from '../strategies/shared/sizing.js'

export type PreflightCode =
  | 'no_market'
  | 'invalid_qty'
  | 'min_notional'
  | 'leverage_exceeded'
  | 'insufficient_balance'
  | 'kill_switch'
  | 'cap_exceeded'

export type PreflightResult = { ok: true; qty: number } | { ok: false; code: PreflightCode; message: string }

export interface PreflightDeps {
  markets: MarketMetadataProvider
  state: StateStore
  killSwitch: KillSwitch
  risk: RiskConfig
  countIntents: (scope: 'global' | { strategy: StrategyId } | { exchange: Exchange }) => number
  notionalInFlight: (scope: 'global' | { strategy: StrategyId } | { exchange: Exchange }) => number
}

export function preflight(intent: TradeIntent, refPrice: number, deps: PreflightDeps): PreflightResult {
  const { markets, state, killSwitch, risk, countIntents, notionalInFlight } = deps

  if (!killSwitch.canPlaceOrder(intent.exchange, intent.strategy)) {
    return {
      ok: false,
      code: 'kill_switch',
      message: `kill switch: mode=${killSwitch.state().mode}`,
    }
  }

  const market = markets.get(intent.exchange, intent.symbol)
  if (!market) {
    return {
      ok: false,
      code: 'no_market',
      message: `market not found: ${intent.exchange}/${intent.symbol}`,
    }
  }

  if (market.maxLeverage !== undefined && intent.leverage > market.maxLeverage) {
    return {
      ok: false,
      code: 'leverage_exceeded',
      message: `leverage ${String(intent.leverage)} exceeds market max ${String(market.maxLeverage)}`,
    }
  }

  const qty = computeOrderQty(intent.amountUsd, refPrice, intent.leverage, market)
  if (qty === null || qty <= 0) {
    return {
      ok: false,
      code: 'invalid_qty',
      message: `could not compute valid qty for amountUsd=${String(intent.amountUsd)} price=${String(refPrice)}`,
    }
  }

  if (market.minCost !== undefined && qty * refPrice < market.minCost) {
    return {
      ok: false,
      code: 'min_notional',
      message: `notional ${String(qty * refPrice)} below minCost ${String(market.minCost)}`,
    }
  }

  const margin = intent.amountUsd / intent.leverage
  const balances = state.balances(intent.exchange, 'USDT')
  const available = balances[0]?.available ?? 0
  if (available < margin) {
    return {
      ok: false,
      code: 'insufficient_balance',
      message: `available USDT ${String(available)} < required margin ${String(margin)}`,
    }
  }

  const globalIntents = countIntents('global')
  if (globalIntents >= risk.globalMaxConcurrentIntents) {
    return {
      ok: false,
      code: 'cap_exceeded',
      message: `global concurrent intent cap ${String(risk.globalMaxConcurrentIntents)} reached`,
    }
  }

  if (notionalInFlight('global') + intent.amountUsd > risk.globalMaxNotionalUsd) {
    return {
      ok: false,
      code: 'cap_exceeded',
      message: `global notional cap ${String(risk.globalMaxNotionalUsd)} would be exceeded`,
    }
  }

  const stratCfg = risk.perStrategy[intent.strategy]
  if (stratCfg !== undefined) {
    if (countIntents({ strategy: intent.strategy }) >= stratCfg.maxConcurrentIntents) {
      return {
        ok: false,
        code: 'cap_exceeded',
        message: `strategy ${intent.strategy} concurrent intent cap ${String(stratCfg.maxConcurrentIntents)} reached`,
      }
    }
    if (notionalInFlight({ strategy: intent.strategy }) + intent.amountUsd > stratCfg.maxNotionalUsd) {
      return {
        ok: false,
        code: 'cap_exceeded',
        message: `strategy ${intent.strategy} notional cap ${String(stratCfg.maxNotionalUsd)} would be exceeded`,
      }
    }
  }

  return { ok: true, qty }
}
