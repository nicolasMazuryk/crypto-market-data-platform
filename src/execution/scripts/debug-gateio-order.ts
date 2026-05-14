import { config } from 'dotenv'
config()
import ccxt from 'ccxt'

const ex = new (ccxt as any).gateio({
  apiKey: process.env.GATEIO_API_KEY!,
  secret: process.env.GATEIO_API_SECRET!,
  defaultType: 'swap',
  enableRateLimit: true,
})

// Place a tiny market order and inspect raw response
const symbol = 'BTC/USDT:USDT'
const qty = 1  // gateio min precision = 1 contract
console.log(`Placing market BUY ${qty} ${symbol}...`)
try {
  const raw = await ex.createOrder(symbol, 'market', 'buy', qty, undefined, {
    marginMode: 'cross',
    text: 'debug-test-' + Date.now(),
    leverage: 2,
  })
  console.log('raw.id:', raw.id)
  console.log('raw.id type:', typeof raw.id)
  console.log('Full response keys:', Object.keys(raw))
  console.log('Response:', JSON.stringify({ id: raw.id, status: raw.status, filled: raw.filled, average: raw.average }, null, 2))

  if (raw.filled > 0) {
    console.log('\nClosing the position...')
    const close = await ex.createOrder(symbol, 'market', 'sell', raw.filled, undefined, {
      marginMode: 'cross', reduceOnly: true,
    })
    console.log('Close:', JSON.stringify({ id: close.id, status: close.status }, null, 2))
  }
} catch (err: any) {
  console.error('Error:', err.message)
}
