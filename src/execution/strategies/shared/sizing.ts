import type { MarketMetadata } from '../../markets/types.js'

// CCXT (precisionMode 4) returns precision.amount as the tick size directly.
// e.g. Bybit GIGA = 10, Gate.io DRIFT = 1, Binance BTC = 0.001
export function lotStep(precision: number): number {
  return precision > 0 ? precision : 1
}

function roundDownToStep(value: number, step: number): number {
  return Math.floor(value / step) * step
}

function roundUpToStep(value: number, step: number): number {
  return Math.ceil(value / step) * step
}

/**
 * Compute the minimum valid order quantity for a market (lot-size floor + minNotional floor).
 * Returns null only if price is non-positive.
 */
export function computeMinOrderQty(market: MarketMetadata, price: number): number | null {
  if (price <= 0) return null

  const contractSize = market.contractSize > 0 ? market.contractSize : 1
  const step = lotStep(market.amountPrecision)

  const lotFloor = market.minAmount ?? step
  const notionalFloor =
    market.minCost !== undefined ? roundUpToStep(market.minCost / price / contractSize, step) : 0

  const rawMin = Math.max(lotFloor, notionalFloor, step)
  const qty = roundUpToStep(rawMin, step)

  return qty > 0 ? qty : null
}

/**
 * Compute order quantity from notional amount for a linear perpetual.
 * Returns null when resulting qty fails market minimums.
 */
export function computeOrderQty(
  amountUsd: number,
  price: number,
  _leverage: number,
  market: MarketMetadata
): number | null {
  if (price <= 0 || amountUsd <= 0) return null

  // For contract-based exchanges (e.g. KuCoin: contractSize=0.001 BTC/contract),
  // qty is expressed in contracts, not base asset units.
  const contractSize = market.contractSize > 0 ? market.contractSize : 1
  const rawQty = amountUsd / price / contractSize

  // amountPrecision may be stored as decimal-place count (e.g. 3) or as
  // a tick size directly (e.g. 0.001) depending on the CCXT precision mode.
  // When < 1 treat it as tick size; when >= 1 treat it as decimal-place count.
  const step = lotStep(market.amountPrecision)
  let qty = roundDownToStep(rawQty, step)

  if (qty <= 0) return null
  if (market.maxAmount !== undefined && qty > market.maxAmount) qty = market.maxAmount
  if (market.minAmount !== undefined && qty < market.minAmount) return null
  if (market.minCost !== undefined && qty * contractSize * price < market.minCost) return null

  return qty
}
