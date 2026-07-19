import { config } from 'dotenv'
config()
import { createGateioOrderWsAdapter } from '../adapters/orderws/gateio.js'

const { GATEIO_API_KEY, GATEIO_API_SECRET } = process.env
if (!GATEIO_API_KEY || !GATEIO_API_SECRET) {
  throw new Error('GATEIO_API_KEY and GATEIO_API_SECRET must be set')
}

const adapter = createGateioOrderWsAdapter({
  credentials: {
    apiKey: GATEIO_API_KEY,
    apiSecret: GATEIO_API_SECRET,
  },
})

await adapter.connect()

const clientOrderId = `debug-ws-${String(Date.now())}`
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
    clientOrderId: `close-${String(Date.now())}`,
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
