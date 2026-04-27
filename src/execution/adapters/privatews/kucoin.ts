import type { ExchangeConfig, ExchangeCredentials } from '../../config/types.js'
import type { ExchangePrivateWsAdapter } from './types.js'
import {
  createPrivateWsAdapterFromSpec,
  type PrivateWsAdapterOptions,
  type PrivateWsAdapterSpec,
  type PrivateWsClient,
} from './private-ws-base.js'
import { createKucoinWsClient, type KucoinWsClientOptions } from './kucoin-client.js'
import { parseKucoinMessage } from './kucoin-mapping.js'

export interface KucoinPrivateWsAdapterOptions extends PrivateWsAdapterOptions {
  wsClientFactory?: () => PrivateWsClient
}

const kucoinSpec: PrivateWsAdapterSpec = {
  exchange: 'kucoin',
  createClient: (config: ExchangeConfig & { credentials?: ExchangeCredentials }) => {
    const clientOpts: KucoinWsClientOptions = {}
    if (config.credentials) {
      clientOpts.credentials = {
        apiKey: config.credentials.apiKey,
        apiSecret: config.credentials.apiSecret,
        apiPassphrase: config.credentials.apiPassphrase ?? '',
      }
    }
    if (config.privateWsUrl) clientOpts.wsBaseUrl = config.privateWsUrl
    return createKucoinWsClient(clientOpts)
  },
  parseMessage: (raw, receivedAt, seq) => parseKucoinMessage(raw, receivedAt, seq),
}

export function createKucoinPrivateWsAdapter(opts: KucoinPrivateWsAdapterOptions): ExchangePrivateWsAdapter {
  const spec = opts.wsClientFactory
    ? { ...kucoinSpec, createClient: opts.wsClientFactory }
    : kucoinSpec
  return createPrivateWsAdapterFromSpec(spec, opts)
}
