import type { Exchange } from '../types/exchange.js'

export function makeOrderKey(exchange: Exchange, clientOrderId: string): string {
  return `${exchange}:${clientOrderId}`
}

export function makePositionKey(exchange: Exchange, symbol: string): string {
  return `${exchange}:${symbol}`
}

export function makeBalanceKey(exchange: Exchange, asset: string): string {
  return `${exchange}:${asset}`
}
