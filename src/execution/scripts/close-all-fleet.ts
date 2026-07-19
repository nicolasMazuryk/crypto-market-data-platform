import { setDefaultResultOrder } from 'node:dns'
import ccxt from 'ccxt'
import { loadRegistry } from '../provisioning/registry/loader.js'
import type { CcxtExchange } from '../../exchanges/types.js'

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

function requireCcxtMethod<K extends keyof CcxtExchange>(ex: CcxtExchange, name: K): NonNullable<CcxtExchange[K]> {
  const method = ex[name]
  if (method === undefined) {
    throw new Error(`CCXT method not implemented: ${name}`)
  }
  return method as NonNullable<CcxtExchange[K]>
}

const registry = loadRegistry('live-configs/registry.yaml')
const active = registry.combinations.filter(c => c.status === 'active')

console.log(`Fleet cleanup: ${String(active.length)} active sub-accounts`)

let errors = 0

for (const entry of active) {
  const ccxtId = CCXT_ID[entry.exchange]
  if (!ccxtId) {
    console.error(`[${entry.exchange}/${entry.assigned_strategy ?? ''}] unknown exchange, skipping`)
    errors++
    continue
  }

  const label = `${entry.exchange}/${entry.assigned_strategy ?? ''}`
  const ccxtRegistry = ccxt as unknown as Record<string, new (c?: Record<string, unknown>) => CcxtExchange>
  const Cls = ccxtRegistry[ccxtId]
  if (!Cls) throw new Error(`CCXT class not found: ${ccxtId}`)
  const options: Record<string, unknown> = {
    apiKey: entry.api_key,
    secret: entry.api_secret,
    enableRateLimit: true,
    options: { warnOnFetchOpenOrdersWithoutSymbol: false },
  }
  if (entry.api_passphrase) options.password = entry.api_passphrase
  const defaultType = DEFAULT_TYPE[entry.exchange]
  if (defaultType) options.defaultType = defaultType

  const ex = new Cls(options)

  // Cancel all open orders
  try {
    const openOrders = await requireCcxtMethod(ex, 'fetchOpenOrders').call(ex)
    if (openOrders.length === 0) {
      console.log(`[${label}] no open orders`)
    } else {
      console.log(`[${label}] cancelling ${String(openOrders.length)} open order(s)`)
      for (const order of openOrders) {
        await requireCcxtMethod(ex, 'cancelOrder').call(ex, order.id, order.symbol)
        console.log(`[${label}] cancelled order ${order.id} ${order.symbol}`)
      }
    }
  } catch (e) {
    console.error(`[${label}] error cancelling orders: ${e instanceof Error ? e.message : String(e)}`)
    errors++
  }

  // Close all open positions
  try {
    const positions = await requireCcxtMethod(ex, 'fetchPositions').call(ex)
    const open = positions.filter(p => Math.abs(p.contracts ?? 0) > 0)
    if (open.length === 0) {
      console.log(`[${label}] no open positions`)
    } else {
      console.log(`[${label}] closing ${String(open.length)} position(s)`)
      for (const pos of open) {
        const side = pos.side === 'long' ? 'sell' : 'buy'
        const qty = Math.abs(pos.contracts ?? 0)
        try {
          const order = await requireCcxtMethod(ex, 'createOrder').call(
            ex,
            pos.symbol,
            'market',
            side,
            qty,
            undefined,
            {
              reduceOnly: true,
            }
          )
          console.log(`[${label}] closed ${pos.symbol} orderId=${order.id}`)
        } catch (e) {
          console.error(`[${label}] error closing ${pos.symbol}: ${e instanceof Error ? e.message : String(e)}`)
          errors++
        }
      }
    }
  } catch (e) {
    console.error(`[${label}] error fetching positions: ${e instanceof Error ? e.message : String(e)}`)
    errors++
  }
}

if (errors > 0) {
  console.error(`\n${String(errors)} error(s) during fleet cleanup`)
  process.exit(1)
}
console.log('\nAll fleet sub-accounts clean: no open orders, no open positions.')
