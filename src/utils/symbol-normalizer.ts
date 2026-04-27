const BASE_ALIASES: Record<string, string> = { XBT: 'BTC' }

export function normalizeSymbol(ccxtSymbol: string): string {
  const trimmed = ccxtSymbol.trim().toUpperCase()
  const [base = trimmed] = trimmed.split(':')
  const cleaned = base.replace(/[\\/_-]/g, '')
  const quoteIndex = cleaned.lastIndexOf('USDT')

  if (quoteIndex === -1) {
    return cleaned
  }

  const baseToken = cleaned.slice(0, quoteIndex)
  const resolvedBase = BASE_ALIASES[baseToken] ?? baseToken
  return resolvedBase + 'USDT'
}
