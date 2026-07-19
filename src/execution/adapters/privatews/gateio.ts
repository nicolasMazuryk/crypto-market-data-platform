import type { ExchangeConfig, ExchangeCredentials } from '../../config/types.js'
import type { ExchangePrivateWsAdapter } from './types.js'
import {
  createPrivateWsAdapterFromSpec,
  type PrivateWsAdapterOptions,
  type PrivateWsAdapterSpec,
  type PrivateWsClient,
} from './private-ws-base.js'
import { createGateioWsClient, type GateioWsClientOptions } from './gateio-client.js'
import { createGateioMessageParser } from './gateio-mapping.js'

export interface GateioPrivateWsAdapterOptions extends PrivateWsAdapterOptions {
  wsClientFactory?: () => PrivateWsClient
}

export function createGateioPrivateWsAdapter(opts: GateioPrivateWsAdapterOptions): ExchangePrivateWsAdapter {
  const parseMessage = createGateioMessageParser()
  const spec: PrivateWsAdapterSpec = {
    exchange: 'gateio',
    createClient:
      opts.wsClientFactory ??
      ((config: ExchangeConfig & { credentials?: ExchangeCredentials }) => {
        const clientOpts: GateioWsClientOptions = {}
        if (config.credentials) {
          clientOpts.credentials = { apiKey: config.credentials.apiKey, apiSecret: config.credentials.apiSecret }
        }
        if (config.privateWsUrl) clientOpts.wsBaseUrl = config.privateWsUrl
        return createGateioWsClient(clientOpts)
      }),
    parseMessage: (raw, receivedAt, seq) => parseMessage(raw, receivedAt, seq),
  }
  return createPrivateWsAdapterFromSpec(spec, opts)
}
