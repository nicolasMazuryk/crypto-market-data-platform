import { config } from 'dotenv'
config()
import ccxt from 'ccxt'
import type { CcxtExchange } from '../../exchanges/types.js'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set`)
  return value
}

interface ExchangeCheckConfig {
  name: string
  ccxtId: string
  apiKey: string
  apiSecret: string
  password: string | undefined
  options: Record<string, unknown>
}

const exchanges: ExchangeCheckConfig[] = [
  {
    name: 'gateio',
    ccxtId: 'gateio',
    apiKey: requireEnv('GATEIO_API_KEY'),
    apiSecret: requireEnv('GATEIO_API_SECRET'),
    password: undefined,
    options: { defaultType: 'swap' },
  },
  {
    name: 'bybit',
    ccxtId: 'bybit',
    apiKey: requireEnv('BYBIT_API_KEY'),
    apiSecret: requireEnv('BYBIT_API_SECRET'),
    password: undefined,
    options: { defaultType: 'swap' },
  },
  {
    name: 'binance',
    ccxtId: 'binanceusdm',
    apiKey: requireEnv('BINANCE_API_KEY'),
    apiSecret: requireEnv('BINANCE_API_SECRET'),
    password: undefined,
    options: {},
  },
  {
    name: 'okx',
    ccxtId: 'okx',
    apiKey: requireEnv('OKX_API_KEY'),
    apiSecret: requireEnv('OKX_API_SECRET'),
    password: process.env.OKX_API_PASS,
    options: {},
  },
  {
    name: 'kucoin',
    ccxtId: 'kucoinfutures',
    apiKey: requireEnv('KUCOIN_API_KEY'),
    apiSecret: requireEnv('KUCOIN_API_SECRET'),
    password: process.env.KUCOIN_API_PASS,
    options: {},
  },
  {
    name: 'bitget',
    ccxtId: 'bitget',
    apiKey: requireEnv('BITGET_API_KEY'),
    apiSecret: requireEnv('BITGET_API_SECRET'),
    password: process.env.BITGET_API_PASS,
    options: { defaultType: 'swap' },
  },
]

for (const cfg of exchanges) {
  const registry = ccxt as unknown as Record<string, new (c?: Record<string, unknown>) => CcxtExchange>
  const Cls = registry[cfg.ccxtId]
  if (!Cls) throw new Error(`CCXT class not found: ${cfg.ccxtId}`)
  const options: Record<string, unknown> = {
    apiKey: cfg.apiKey,
    secret: cfg.apiSecret,
    defaultType: 'swap',
    enableRateLimit: true,
  }
  if (cfg.password) options.password = cfg.password
  const ex = new Cls(options)
  if (!ex.fetchPositions) throw new Error(`${cfg.name}: fetchPositions not supported`)
  const positions = await ex.fetchPositions()
  const open = positions.filter(p => Math.abs(p.contracts ?? 0) > 0)
  if (open.length > 0) {
    console.log(
      `[${cfg.name}] OPEN POSITIONS:`,
      JSON.stringify(
        open.map(p => ({ symbol: p.symbol, side: p.side, contracts: p.contracts, entryPrice: p.entryPrice })),
        null,
        2
      )
    )
  } else {
    console.log(`[${cfg.name}] no open positions`)
  }
}
