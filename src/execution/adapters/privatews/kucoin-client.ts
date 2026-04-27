import { makeTypedEmitter } from './binance-client.js'
import type { PrivateWsClient, PrivateWsClientEvents } from './private-ws-base.js'

export interface KucoinWsCredentials {
  apiKey: string
  apiSecret: string
  apiPassphrase: string
}

export interface KucoinWsClientOptions {
  credentials?: KucoinWsCredentials
  wsBaseUrl?: string
}

export function createKucoinWsClient(opts: KucoinWsClientOptions): PrivateWsClient {
  const emitter = makeTypedEmitter<PrivateWsClientEvents>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdkClient: any = null

  return {
    async connect(): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { WebsocketClient } = await import('kucoin-api')
      const clientOpts: Record<string, unknown> = {}
      if (opts.credentials) {
        clientOpts.apiKey = opts.credentials.apiKey
        clientOpts.apiSecret = opts.credentials.apiSecret
        clientOpts.apiPassphrase = opts.credentials.apiPassphrase
      }
      if (opts.wsBaseUrl) clientOpts.wsUrl = opts.wsBaseUrl

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      sdkClient = new WebsocketClient(clientOpts as ConstructorParameters<typeof WebsocketClient>[0])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      sdkClient.on('error', (err: any) => {
        const e = err instanceof Error ? err : new Error(String(err))
        emitter.emit('error', e)
      })
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      sdkClient.on('close', () => {
        emitter.emit('close', 'connection closed')
      })
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      sdkClient.on('update', (data: unknown) => {
        emitter.emit('message', data)
      })

      // KuCoin Futures private topics — wsKey must be 'futuresPrivateV1'
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await sdkClient.subscribe(
        ['/contractMarket/tradeOrders', '/contractAccount/wallet'],
        'futuresPrivateV1'
      )
    },

    async disconnect(): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const client = sdkClient
      sdkClient = null
      if (client) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          client.removeAllListeners()
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          await client.closeAll(true)
        } catch {
          // ignore
        }
      }
    },

    events: emitter,
  }
}
