import { makeTypedEmitter } from './binance-client.js'
import type { PrivateWsClient, PrivateWsClientEvents } from './private-ws-base.js'

export interface BybitWsCredentials {
  apiKey: string
  apiSecret: string
}

export interface BybitWsClientOptions {
  credentials?: BybitWsCredentials
  wsBaseUrl?: string
}

export function createBybitWsClient(opts: BybitWsClientOptions): PrivateWsClient {
  const emitter = makeTypedEmitter<PrivateWsClientEvents>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdkClient: any = null

  return {
    async connect(): Promise<void> {
      const { WebsocketClient } = await import('bybit-api')
      const clientOpts: Record<string, unknown> = { market: 'v5' }
      if (opts.credentials) {
        clientOpts.key = opts.credentials.apiKey
        clientOpts.secret = opts.credentials.apiSecret
      }
      if (opts.wsBaseUrl) clientOpts.wsUrl = opts.wsBaseUrl

      sdkClient = new WebsocketClient(clientOpts as unknown as ConstructorParameters<typeof WebsocketClient>[0])

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

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await sdkClient.subscribeV5(['order', 'position', 'wallet', 'execution'], 'linear')
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
