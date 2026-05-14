import { config } from 'dotenv'
config()
import { createGateioOrderWsAdapter } from '../adapters/orderws/gateio.js'

const adapter = createGateioOrderWsAdapter({
  credentials: {
    apiKey: process.env.GATEIO_API_KEY!,
    apiSecret: process.env.GATEIO_API_SECRET!,
  },
})

await adapter.connect()

const clientOrderId = 'debug-ws-' + Date.now()
console.log(`Placing WS BUY 1 BTC_USDT (clientOrderId=${clientOrderId})...`)

const ack = await adapter.createOrder({
  intentId: 'debug',
  exchange: 'gateio',
  clientOrderId,
  symbol: 'BTC_USDT',
  side: 'buy',
  type: 'market',
  qty: 1,
  reduceOnly: false,
})

console.log('Ack:', JSON.stringify(ack, null, 2))
console.log('exchangeOrderId resolved:', ack.exchangeOrderId)
console.log('status:', ack.status)

if (ack.status === 'accepted' && ack.exchangeOrderId) {
  console.log('\nClosing position...')
  const closeAck = await adapter.createOrder({
    intentId: 'debug',
    exchange: 'gateio',
    clientOrderId: 'close-' + Date.now(),
    symbol: 'BTC_USDT',
    side: 'sell',
    type: 'market',
    qty: 1,
    reduceOnly: true,
  })
  console.log('Close ack:', JSON.stringify(closeAck, null, 2))
}

await adapter.disconnect()
process.exit(0)
