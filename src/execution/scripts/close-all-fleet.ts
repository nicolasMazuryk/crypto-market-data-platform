import { setDefaultResultOrder } from 'node:dns'
import ccxt from 'ccxt'
import { loadRegistry } from '../provisioning/registry/loader.js'

// Force IPv4 so API keys whitelisted on IPv4 addresses (not IPv6) are accepted
setDefaultResultOrder('ipv4first')

const CCXT_ID: Record<string, string> = {
  binance: 'binanceusdm',
  bybit: 'bybit',
  okx: 'okx',
  gateio: 'gateio',
  kucoin: 'kucoinfutures',
  bitget: 'bitget',
}

const DEFAULT_TYPE: Record<string, string | undefined> = {
  binance: undefined,
  bybit: 'swap',
  okx: 'swap',
  gateio: 'swap',
  kucoin: undefined,
  bitget: 'swap',
}

const registry = loadRegistry('live-configs/registry.yaml')
const active = registry.combinations.filter(c => c.status === 'active')

console.log(`Fleet cleanup: ${active.length} active sub-accounts`)

let errors = 0

for (const entry of active) {
  const ccxtId = CCXT_ID[entry.exchange]
  if (!ccxtId) {
    console.error(`[${entry.exchange}/${entry.assigned_strategy}] unknown exchange, skipping`)
    errors++
    continue
  }

  const label = `${entry.exchange}/${entry.assigned_strategy}`
  const ccxtRegistry = ccxt as unknown as Record<string, new (c?: Record<string, unknown>) => any>
  const options: Record<string, unknown> = {
    apiKey: entry.api_key,
    secret: entry.api_secret,
    enableRateLimit: true,
    options: { warnOnFetchOpenOrdersWithoutSymbol: false },
  }
  if (entry.api_passphrase) options.password = entry.api_passphrase
  const defaultType = DEFAULT_TYPE[entry.exchange]
  if (defaultType) options.defaultType = defaultType

  const ex = new ccxtRegistry[ccxtId]!(options)

  // Cancel all open orders
  try {
    const openOrders = (await ex.fetchOpenOrders()) as any[]
    if (openOrders.length === 0) {
      console.log(`[${label}] no open orders`)
    } else {
      console.log(`[${label}] cancelling ${openOrders.length} open order(s)`)
      for (const order of openOrders) {
        await ex.cancelOrder(order.id as string, order.symbol as string)
        console.log(`[${label}] cancelled order ${order.id as string} ${order.symbol as string}`)
      }
    }
  } catch (e: any) {
    console.error(`[${label}] error cancelling orders: ${e.message as string}`)
    errors++
  }

  // Close all open positions
  try {
    const positions = (await ex.fetchPositions()) as any[]
    const open = positions.filter(p => Math.abs(p.contracts ?? 0) > 0)
    if (open.length === 0) {
      console.log(`[${label}] no open positions`)
    } else {
      console.log(`[${label}] closing ${open.length} position(s)`)
      for (const pos of open) {
        const side = pos.side === 'long' ? 'sell' : 'buy'
        const qty = Math.abs(pos.contracts as number)
        try {
          const order = (await ex.createOrder(pos.symbol as string, 'market', side, qty, undefined, {
            reduceOnly: true,
          }))
          console.log(`[${label}] closed ${pos.symbol as string} orderId=${order.id as string}`)
        } catch (e: any) {
          console.error(`[${label}] error closing ${pos.symbol as string}: ${e.message as string}`)
          errors++
        }
      }
    }
  } catch (e: any) {
    console.error(`[${label}] error fetching positions: ${e.message as string}`)
    errors++
  }
}

if (errors > 0) {
  console.error(`\n${errors} error(s) during fleet cleanup`)
  process.exit(1)
}
console.log('\nAll fleet sub-accounts clean: no open orders, no open positions.')
