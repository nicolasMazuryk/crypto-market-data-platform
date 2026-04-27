import { createHash, randomUUID } from 'node:crypto'

import type { ClientOrderIdDeriver } from './types.js'

const MAX_CLIENT_ORDER_ID_LENGTH = 28

function truncateOrHash(raw: string, maxLen: number): string {
  if (raw.length <= maxLen) return raw
  const digest = createHash('sha256').update(raw).digest('hex')
  return digest.slice(0, maxLen)
}

export interface ExecutionIds extends ClientOrderIdDeriver {
  newIntentId(): string
  intentId(strategy: string, exchange: string, symbol: string, nextFundingTimestamp: number): string
}

export function createIds(): ExecutionIds {
  return {
    newIntentId: () => randomUUID(),
    intentId(strategy, exchange, symbol, nextFundingTimestamp) {
      const raw = `${strategy}|${exchange}|${symbol}|${String(nextFundingTimestamp)}`
      return createHash('sha256').update(raw).digest('hex').slice(0, 32)
    },
    forIntent(intentId, attempt) {
      return truncateOrHash(`${intentId}-${String(attempt)}`, MAX_CLIENT_ORDER_ID_LENGTH)
    },
    forExit(intentId, kind) {
      return truncateOrHash(`${intentId}-${kind}`, MAX_CLIENT_ORDER_ID_LENGTH)
    },
  }
}
