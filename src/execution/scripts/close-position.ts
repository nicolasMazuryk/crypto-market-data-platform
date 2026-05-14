import { config } from 'dotenv'
config()
import ccxt from 'ccxt'

const [, , exchange, symbol, side, qty] = process.argv
if (!exchange || !symbol || !side || !qty) {
  console.error('Usage: close-position.ts <exchange> <symbol> <side> <qty>')
  process.exit(1)
}

const closeSide = side === 'long' ? 'sell' : 'buy'
const registry = ccxt as unknown as Record<string, new (c?: Record<string, unknown>) => any>

let ex: any
if (exchange === 'gateio') {
  ex = new registry.gateio!({ apiKey: process.env.GATEIO_API_KEY!, secret: process.env.GATEIO_API_SECRET!, defaultType: 'swap', enableRateLimit: true })
}

if (!ex) { console.error('Unknown exchange:', exchange); process.exit(1) }

console.log(`Closing ${exchange} ${symbol} ${side} ${qty} via ${closeSide} reduce-only market order...`)
const order = await ex.createOrder(symbol, 'market', closeSide, parseFloat(qty), undefined, { reduceOnly: true })
console.log('Closed:', JSON.stringify({ id: order.id, symbol: order.symbol, status: order.status, filled: order.filled, average: order.average }, null, 2))
