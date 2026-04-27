import type { MarketMetadata } from '../../markets/types.js'

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
  const step =
    market.amountPrecision <= 0
      ? 1
      : market.amountPrecision < 1
        ? market.amountPrecision
        : Math.pow(10, -Math.round(market.amountPrecision))
  const qty = Math.floor(rawQty / step) * step

  if (qty <= 0) return null
  if (market.minAmount !== undefined && qty < market.minAmount) return null
  if (market.minCost !== undefined && qty * price < market.minCost) return null

  return qty
}
