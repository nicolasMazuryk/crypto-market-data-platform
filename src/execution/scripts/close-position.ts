import { config } from 'dotenv'
config()
import ccxt from 'ccxt'
import type { CcxtExchange } from '../../exchanges/types.js'

const [, , exchange, symbol, side, qty] = process.argv
if (!exchange || !symbol || !side || !qty) {
  console.error('Usage: close-position.ts <exchange> <symbol> <side> <qty>')
  process.exit(1)
}

const closeSide = side === 'long' ? 'sell' : 'buy'
const registry = ccxt as unknown as Record<string, new (c?: Record<string, unknown>) => CcxtExchange>

let ex: CcxtExchange | undefined
if (exchange === 'gateio') {
  const { GATEIO_API_KEY, GATEIO_API_SECRET } = process.env
  if (!GATEIO_API_KEY || !GATEIO_API_SECRET) {
    throw new Error('GATEIO_API_KEY and GATEIO_API_SECRET must be set')
  }
  const Cls = registry.gateio
  if (!Cls) throw new Error('CCXT class not found: gateio')
  ex = new Cls({ apiKey: GATEIO_API_KEY, secret: GATEIO_API_SECRET, defaultType: 'swap', enableRateLimit: true })
}

if (!ex) {
  console.error('Unknown exchange:', exchange)
  process.exit(1)
}
if (!ex.createOrder) throw new Error(`${exchange}: createOrder not supported`)

console.log(`Closing ${exchange} ${symbol} ${side} ${qty} via ${closeSide} reduce-only market order...`)
const order = await ex.createOrder(symbol, 'market', closeSide, parseFloat(qty), undefined, { reduceOnly: true })
console.log(
  'Closed:',
  JSON.stringify(
    {
      id: order.id,
      symbol: order.symbol,
      status: order.status ?? '',
      filled: order.filled ?? 0,
      average: order.average ?? 0,
    },
    null,
    2
  )
)
