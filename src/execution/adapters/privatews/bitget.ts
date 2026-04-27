import type { ExchangeConfig, ExchangeCredentials } from '../../config/types.js'
import type { ExchangePrivateWsAdapter } from './types.js'
import {
  createPrivateWsAdapterFromSpec,
  type PrivateWsAdapterOptions,
  type PrivateWsAdapterSpec,
  type PrivateWsClient,
} from './private-ws-base.js'
import { createBitgetWsClient, type BitgetWsClientOptions } from './bitget-client.js'
import { parseBitgetMessage } from './bitget-mapping.js'

export interface BitgetPrivateWsAdapterOptions extends PrivateWsAdapterOptions {
  wsClientFactory?: () => PrivateWsClient
}

const bitgetSpec: PrivateWsAdapterSpec = {
  exchange: 'bitget',
  createClient: (config: ExchangeConfig & { credentials?: ExchangeCredentials }) => {
    const clientOpts: BitgetWsClientOptions = {}
    if (config.credentials) {
      clientOpts.credentials = {
        apiKey: config.credentials.apiKey,
        apiSecret: config.credentials.apiSecret,
        apiPassphrase: config.credentials.apiPassphrase ?? '',
      }
    }
    if (config.privateWsUrl) clientOpts.wsBaseUrl = config.privateWsUrl
    return createBitgetWsClient(clientOpts)
  },
  parseMessage: (raw, receivedAt, seq) => parseBitgetMessage(raw, receivedAt, seq),
}

export function createBitgetPrivateWsAdapter(opts: BitgetPrivateWsAdapterOptions): ExchangePrivateWsAdapter {
  const spec = opts.wsClientFactory
    ? { ...bitgetSpec, createClient: opts.wsClientFactory }
    : bitgetSpec
  return createPrivateWsAdapterFromSpec(spec, opts)
}
