#!/usr/bin/env node
// Cancels all open orders across all active sub-accounts using registry.yaml credentials.
// Usage: node scripts/cancel-all-orders.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import YAML from 'yaml'

const require = createRequire(import.meta.url)
const ccxt = require('ccxt')

const registry = YAML.parse(readFileSync('live-configs/registry.yaml', 'utf8'))
const active = registry.combinations.filter(c => c.status === 'active')

const CCXT_IDS = {
  binance: { id: 'binanceusdm', options: {} },
  bybit: { id: 'bybit', options: { defaultType: 'swap' } },
  okx: { id: 'okx', options: { defaultType: 'swap' } },
  bitget: { id: 'bitget', options: { defaultType: 'swap' } },
  gateio: { id: 'gateio', options: { defaultType: 'swap' } },
  kucoin: { id: 'kucoinfutures', options: {} },
}

async function cancelAllForAccount(combo) {
  const cfg = CCXT_IDS[combo.exchange]
  if (!cfg) {
    console.log(`[SKIP] ${combo.exchange}/${combo.assigned_strategy}: no CCXT config`)
    return
  }

  const ExchangeClass = ccxt[cfg.id]
  const exchange = new ExchangeClass({
    apiKey: combo.api_key,
    secret: combo.api_secret,
    ...(combo.api_passphrase ? { password: combo.api_passphrase } : {}),
    ...cfg.options,
    enableRateLimit: true,
    options: { ...cfg.options.options },
  })

  const label = `${combo.exchange}/${combo.assigned_strategy}`
  try {
    const openOrders = await exchange.fetchOpenOrders()
    if (openOrders.length === 0) {
      console.log(`[OK] ${label}: no open orders`)
      return
    }
    console.log(`[INFO] ${label}: ${openOrders.length} open orders — cancelling...`)
    // Use cancelAllOrders if available, otherwise cancel individually
    try {
      await exchange.cancelAllOrders()
      console.log(`[OK] ${label}: cancelled all via cancelAllOrders`)
    } catch {
      let cancelled = 0
      for (const order of openOrders) {
        try {
          await exchange.cancelOrder(order.id, order.symbol)
          cancelled++
        } catch (e) {
          console.log(`[WARN] ${label}: failed to cancel order ${order.id}: ${e.message}`)
        }
      }
      console.log(`[OK] ${label}: cancelled ${cancelled}/${openOrders.length}`)
    }
  } catch (e) {
    console.log(`[ERR] ${label}: ${e.message}`)
  }
}

console.log(`Cancelling orders for ${active.length} active sub-accounts...`)
// Run 4 at a time to avoid rate limit issues
for (let i = 0; i < active.length; i += 4) {
  const batch = active.slice(i, i + 4)
  await Promise.all(batch.map(cancelAllForAccount))
}
console.log('Done.')
