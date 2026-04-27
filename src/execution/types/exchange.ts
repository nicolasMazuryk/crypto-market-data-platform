export type Exchange = 'binance' | 'bybit' | 'okx' | 'bitget' | 'gateio' | 'kucoin'

export type FundingInterval = 1 | 2 | 4 | 8

export type Unsubscribe = () => void

export interface TypedEventEmitter<TEvents> {
  on<K extends keyof TEvents & string>(
    event: K,
    listener: TEvents[K] extends (...args: infer A) => void ? (...args: A) => void : never
  ): Unsubscribe
  off<K extends keyof TEvents & string>(
    event: K,
    listener: TEvents[K] extends (...args: infer A) => void ? (...args: A) => void : never
  ): void
  emit<K extends keyof TEvents & string>(
    event: K,
    ...args: TEvents[K] extends (...args: infer A) => void ? A : never
  ): void
}
