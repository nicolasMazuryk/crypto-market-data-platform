import type { ExchangeConfig, ExchangeCredentials } from '../../config/types.js'
import type { ExchangePrivateWsAdapter } from './types.js'
import {
  createPrivateWsAdapterFromSpec,
  type PrivateWsAdapterOptions,
  type PrivateWsAdapterSpec,
  type PrivateWsClient,
} from './private-ws-base.js'
import { createBybitWsClient, type BybitWsClientOptions } from './bybit-client.js'
import { parseBybitMessage } from './bybit-mapping.js'

export interface BybitPrivateWsAdapterOptions extends PrivateWsAdapterOptions {
  wsClientFactory?: () => PrivateWsClient
}

const bybitSpec: PrivateWsAdapterSpec = {
  exchange: 'bybit',
  createClient: (config: ExchangeConfig & { credentials?: ExchangeCredentials }) => {
    const clientOpts: BybitWsClientOptions = {}
    if (config.credentials) {
      clientOpts.credentials = { apiKey: config.credentials.apiKey, apiSecret: config.credentials.apiSecret }
    }
    if (config.privateWsUrl) clientOpts.wsBaseUrl = config.privateWsUrl
    return createBybitWsClient(clientOpts)
  },
  parseMessage: (raw, receivedAt, seq) => parseBybitMessage(raw, receivedAt, seq),
}

export function createBybitPrivateWsAdapter(opts: BybitPrivateWsAdapterOptions): ExchangePrivateWsAdapter {
  const spec = opts.wsClientFactory ? { ...bybitSpec, createClient: opts.wsClientFactory } : bybitSpec
  return createPrivateWsAdapterFromSpec(spec, opts)
}
