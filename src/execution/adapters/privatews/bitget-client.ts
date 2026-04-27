import { makeTypedEmitter } from './binance-client.js'
import type { PrivateWsClient, PrivateWsClientEvents } from './private-ws-base.js'

export interface BitgetWsCredentials {
  apiKey: string
  apiSecret: string
  apiPassphrase: string
}

export interface BitgetWsClientOptions {
  credentials?: BitgetWsCredentials
  wsBaseUrl?: string
}

export function createBitgetWsClient(opts: BitgetWsClientOptions): PrivateWsClient {
  const emitter = makeTypedEmitter<PrivateWsClientEvents>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdkClient: any = null

  return {
    async connect(): Promise<void> {
      const { WebsocketClientV2 } = await import('bitget-api')
      const clientOpts: Record<string, unknown> = {}
      if (opts.credentials) {
        clientOpts.apiKey = opts.credentials.apiKey
        clientOpts.apiSecret = opts.credentials.apiSecret
        clientOpts.apiPass = opts.credentials.apiPassphrase
      }
      if (opts.wsBaseUrl) clientOpts.wsUrl = opts.wsBaseUrl

      sdkClient = new WebsocketClientV2(clientOpts as ConstructorParameters<typeof WebsocketClientV2>[0])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkClient.on('error', (err: any) => {
        const e = err instanceof Error ? err : new Error(String(err))
        emitter.emit('error', e)
      })
      sdkClient.on('close', () => {
        emitter.emit('close', 'connection closed')
      })
      sdkClient.on('update', (data: unknown) => {
        emitter.emit('message', data)
      })

      sdkClient.subscribeTopic('USDT-FUTURES', 'orders')
      sdkClient.subscribeTopic('USDT-FUTURES', 'positions')
      // Account/balance channel subscription intentionally omitted:
      // Bitget V2 WS returns error 30001 for 'account' channel regardless of coin param,
      // which triggers reconnect and causes order fill events to be missed.
      // Balance state is populated via REST reconcile instead.
    },

    async disconnect(): Promise<void> {
      const client = sdkClient
      sdkClient = null
      if (client) {
        try {
          client.removeAllListeners()
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          await client.closeAll(true)
        } catch {
          // ignore
        }
      }
    },

    events: emitter,
  }
}
