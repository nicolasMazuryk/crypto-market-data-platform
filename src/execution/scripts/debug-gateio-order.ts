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

const { GATEIO_API_KEY, GATEIO_API_SECRET } = process.env
if (!GATEIO_API_KEY || !GATEIO_API_SECRET) {
  throw new Error('GATEIO_API_KEY and GATEIO_API_SECRET must be set')
}

const registry = ccxt as unknown as Record<string, new (c?: Record<string, unknown>) => CcxtExchange>
const Cls = registry.gateio
if (!Cls) throw new Error('CCXT class not found: gateio')
const ex = new Cls({
  apiKey: GATEIO_API_KEY,
  secret: GATEIO_API_SECRET,
  defaultType: 'swap',
  enableRateLimit: true,
})

// Place a tiny market order and inspect raw response
const symbol = 'BTC/USDT:USDT'
const qty = 1 // gateio min precision = 1 contract
console.log(`Placing market BUY ${String(qty)} ${symbol}...`)
try {
  const raw = await requireCcxtMethod(ex, 'createOrder').call(ex, symbol, 'market', 'buy', qty, undefined, {
    marginMode: 'cross',
    text: `debug-test-${String(Date.now())}`,
    leverage: 2,
  })
  console.log('raw.id:', raw.id)
  console.log('raw.id type:', typeof raw.id)
  console.log('Full response keys:', Object.keys(raw))
  console.log(
    'Response:',
    JSON.stringify(
      { id: raw.id, status: raw.status ?? '', filled: raw.filled ?? 0, average: raw.average ?? 0 },
      null,
      2
    )
  )

  const filled = raw.filled ?? 0
  if (filled > 0) {
    console.log('\nClosing the position...')
    const close = await requireCcxtMethod(ex, 'createOrder').call(ex, symbol, 'market', 'sell', filled, undefined, {
      marginMode: 'cross',
      reduceOnly: true,
    })
    console.log('Close:', JSON.stringify({ id: close.id, status: close.status ?? '' }, null, 2))
  }
} catch (err) {
  console.error('Error:', err instanceof Error ? err.message : String(err))
}
