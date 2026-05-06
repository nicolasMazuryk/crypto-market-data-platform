import { makeTypedEmitter } from './binance-client.js'
import type { PrivateWsClient, PrivateWsClientEvents } from './private-ws-base.js'

export interface OkxWsCredentials {
  apiKey: string
  apiSecret: string
  apiPassphrase: string
}

export interface OkxWsClientOptions {
  credentials?: OkxWsCredentials
  wsBaseUrl?: string
}

export function createOkxWsClient(opts: OkxWsClientOptions): PrivateWsClient {
  const emitter = makeTypedEmitter<PrivateWsClientEvents>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdkClient: any = null

  return {
    async connect(): Promise<void> {
      const { WebsocketClient } = await import('okx-api')
      const clientOpts: Record<string, unknown> = {}
      if (opts.credentials) {
        clientOpts.accounts = [
          {
            apiKey: opts.credentials.apiKey,
            apiSecret: opts.credentials.apiSecret,
            apiPass: opts.credentials.apiPassphrase,
          },
        ]
      }
      if (opts.wsBaseUrl) clientOpts.wsUrl = opts.wsBaseUrl

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

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await sdkClient.subscribe(
        [{ channel: 'orders', instType: 'ANY' }, { channel: 'positions', instType: 'ANY' }, { channel: 'account' }],
        true // isPrivateTopic
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
