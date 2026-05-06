/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-non-null-assertion */
import ccxt from 'ccxt'
import type { Exchange as CcxtExchangeType } from 'ccxt'

const exchanges = [
  {
    id: 'gateio',
    ccxtId: 'gate',
    key: process.env.GATEIO_API_KEY!,
    secret: process.env.GATEIO_API_SECRET!,
    pass: undefined,
  },
  {
    id: 'okx',
    ccxtId: 'okx',
    key: process.env.OKX_API_KEY!,
    secret: process.env.OKX_API_SECRET!,
    pass: process.env.OKX_API_PASSPHRASE,
  },
  {
    id: 'bitget',
    ccxtId: 'bitget',
    key: process.env.BITGET_API_KEY!,
    secret: process.env.BITGET_API_SECRET!,
    pass: process.env.BITGET_API_PASSPHRASE,
  },
  {
    id: 'kucoin',
    ccxtId: 'kucoinfutures',
    key: process.env.KUCOIN_API_KEY!,
    secret: process.env.KUCOIN_API_SECRET!,
    pass: process.env.KUCOIN_API_PASSPHRASE,
  },
]

async function main() {
  for (const ex of exchanges) {
    try {
      // @ts-expect-error -- ccxt constructor accessed by string key
      const inst = new ccxt[ex.ccxtId]({
        apiKey: ex.key,
        secret: ex.secret,
        password: ex.pass,
        defaultType: 'swap',
      }) as CcxtExchangeType
      await inst.loadMarkets()
      const rates = await inst.fetchFundingRates()
      const sorted = Object.entries(rates)
        .filter(([, r]) => (r as any).fundingRate != null)
        .sort(([, a], [, b]) => (a as any).fundingRate - (b as any).fundingRate)
      const negative = sorted.filter(([, r]) => (r as any).fundingRate < 0).slice(0, 5)
      const mostNeg = negative.map(([sym, r]) => `${sym}=${((r as any).fundingRate * 100).toFixed(4)}%`).join(' | ')
      console.log(`${ex.id}: negative_count=${String(negative.length)} most_negative=[${mostNeg}]`)
      await (inst as any).close?.()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.log(`${ex.id}: ERROR ${msg.slice(0, 120)}`)
    }
  }
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
