import { config } from 'dotenv'
config()
import ccxt from 'ccxt'
import type { CcxtExchange } from '../../exchanges/types.js'

function requireCcxtMethod<K extends keyof CcxtExchange>(ex: CcxtExchange, name: K): NonNullable<CcxtExchange[K]> {
  const method = ex[name]
  if (method === undefined) {
    throw new Error(`CCXT method not implemented: ${name}`)
  }
  return method as NonNullable<CcxtExchange[K]>
}

const registry = ccxt as unknown as Record<string, new (c?: Record<string, unknown>) => CcxtExchange>
const Cls = registry.gateio
if (!Cls) throw new Error('CCXT class not found: gateio')
const ex = new Cls({
  defaultType: 'swap',
  apiKey: process.env.GATEIO_API_KEY,
  secret: process.env.GATEIO_API_SECRET,
})
await ex.loadMarkets()

const positions = await requireCcxtMethod(ex, 'fetchPositions').call(ex)
const open = positions.filter(p => Math.abs(p.contracts ?? 0) > 0)
console.log(
  'Open positions:',
  open.map(p => ({ symbol: p.symbol, contracts: p.contracts, side: p.side, entryPrice: p.entryPrice }))
)

for (const pos of open) {
  const side = pos.side === 'long' ? 'sell' : 'buy'
  const qty = Math.abs(pos.contracts ?? 0)
  console.log(`Closing ${pos.symbol}: ${side} ${String(qty)}`)
  try {
    const order = await requireCcxtMethod(ex, 'createOrder').call(ex, pos.symbol, 'market', side, qty, undefined, {
      reduceOnly: true,
    })
    console.log(`Closed ${pos.symbol}: orderId=${order.id}`)
  } catch (e) {
    console.log(`Error closing ${pos.symbol}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
