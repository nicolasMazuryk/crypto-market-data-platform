import { config } from 'dotenv'
config()
import ccxt from 'ccxt'

const ex = new (ccxt as unknown as Record<string, new (c?: Record<string, unknown>) => any>).gateio!({
  defaultType: 'swap',
  apiKey: process.env.GATEIO_API_KEY,
  secret: process.env.GATEIO_API_SECRET,
})
await ex.loadMarkets()

const positions = await ex.fetchPositions() as any[]
const open = positions.filter(p => Math.abs(p.contracts ?? 0) > 0)
console.log('Open positions:', open.map(p => ({ symbol: p.symbol, contracts: p.contracts, side: p.side, entryPrice: p.entryPrice })))

for (const pos of open) {
  const side = pos.side === 'long' ? 'sell' : 'buy'
  const qty = Math.abs(pos.contracts as number)
  console.log(`Closing ${pos.symbol as string}: ${side} ${qty}`)
  try {
    const order = await ex.createOrder(pos.symbol as string, 'market', side, qty, undefined, { reduceOnly: true })
    console.log(`Closed ${pos.symbol as string}: orderId=${order.id as string}`)
  } catch (e: any) {
    console.log(`Error closing ${pos.symbol as string}: ${e.message as string}`)
  }
}
