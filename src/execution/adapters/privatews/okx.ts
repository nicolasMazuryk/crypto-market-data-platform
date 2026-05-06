import type { ExchangeConfig, ExchangeCredentials } from '../../config/types.js'
import type { ExchangePrivateWsAdapter } from './types.js'
import {
  createPrivateWsAdapterFromSpec,
  type PrivateWsAdapterOptions,
  type PrivateWsAdapterSpec,
  type PrivateWsClient,
} from './private-ws-base.js'
import { createOkxWsClient, type OkxWsClientOptions } from './okx-client.js'
import { parseOkxMessage } from './okx-mapping.js'

export interface OkxPrivateWsAdapterOptions extends PrivateWsAdapterOptions {
  wsClientFactory?: () => PrivateWsClient
}

const okxSpec: PrivateWsAdapterSpec = {
  exchange: 'okx',
  createClient: (config: ExchangeConfig & { credentials?: ExchangeCredentials }) => {
    const clientOpts: OkxWsClientOptions = {}
    if (config.credentials) {
      clientOpts.credentials = {
        apiKey: config.credentials.apiKey,
        apiSecret: config.credentials.apiSecret,
        apiPassphrase: config.credentials.apiPassphrase ?? '',
      }
    }
    if (config.privateWsUrl) clientOpts.wsBaseUrl = config.privateWsUrl
    return createOkxWsClient(clientOpts)
  },
  parseMessage: (raw, receivedAt, seq) => parseOkxMessage(raw, receivedAt, seq),
}

export function createOkxPrivateWsAdapter(opts: OkxPrivateWsAdapterOptions): ExchangePrivateWsAdapter {
  const spec = opts.wsClientFactory ? { ...okxSpec, createClient: opts.wsClientFactory } : okxSpec
  return createPrivateWsAdapterFromSpec(spec, opts)
}
