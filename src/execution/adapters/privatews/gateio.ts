import type { ExchangeConfig, ExchangeCredentials } from '../../config/types.js'
import type { ExchangePrivateWsAdapter } from './types.js'
import {
  createPrivateWsAdapterFromSpec,
  type PrivateWsAdapterOptions,
  type PrivateWsAdapterSpec,
  type PrivateWsClient,
} from './private-ws-base.js'
import { createGateioWsClient, type GateioWsClientOptions } from './gateio-client.js'
import { parseGateioMessage } from './gateio-mapping.js'

export interface GateioPrivateWsAdapterOptions extends PrivateWsAdapterOptions {
  wsClientFactory?: () => PrivateWsClient
}

const gateioSpec: PrivateWsAdapterSpec = {
  exchange: 'gateio',
  createClient: (config: ExchangeConfig & { credentials?: ExchangeCredentials }) => {
    const clientOpts: GateioWsClientOptions = {}
    if (config.credentials) {
      clientOpts.credentials = { apiKey: config.credentials.apiKey, apiSecret: config.credentials.apiSecret }
    }
    if (config.privateWsUrl) clientOpts.wsBaseUrl = config.privateWsUrl
    return createGateioWsClient(clientOpts)
  },
  parseMessage: (raw, receivedAt, seq) => parseGateioMessage(raw, receivedAt, seq),
}

export function createGateioPrivateWsAdapter(opts: GateioPrivateWsAdapterOptions): ExchangePrivateWsAdapter {
  const spec = opts.wsClientFactory ? { ...gateioSpec, createClient: opts.wsClientFactory } : gateioSpec
  return createPrivateWsAdapterFromSpec(spec, opts)
}
