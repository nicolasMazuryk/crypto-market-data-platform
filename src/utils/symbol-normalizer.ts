export function normalizeSymbol(ccxtSymbol: string): string {
  const trimmed = ccxtSymbol.trim().toUpperCase()
  const [base = trimmed] = trimmed.split(':')
  const cleaned = base.replace(/[\\/_-]/g, '')
  const quoteIndex = cleaned.lastIndexOf('USDT')

  if (quoteIndex === -1) {
    return cleaned
  }

  return cleaned.slice(0, quoteIndex + 'USDT'.length)
}
