import type { Logger } from 'pino'

import type { ExchangeConfig, ExchangeCredentials } from '../../config/types.js'
import type { EventBus } from '../../core/types.js'
import type { Clock } from '../../core/types.js'
import type { PrivateWsMetrics } from '../../observability/metrics.js'
import { createBinancePrivateWsAdapter } from './binance.js'
import type { BinanceWsClientFactory } from './binance-client.js'
import { createBitgetPrivateWsAdapter } from './bitget.js'
import { createBybitPrivateWsAdapter } from './bybit.js'
import { createOkxPrivateWsAdapter } from './okx.js'
import { createGateioPrivateWsAdapter } from './gateio.js'
import { createKucoinPrivateWsAdapter } from './kucoin.js'
import { createShadowPrivateWsAdapter } from './shadow.js'
import type { ExchangePrivateWsAdapter } from './types.js'

export interface CreatePrivateWsAdapterOptions {
  engineMode: 'live' | 'dry_run'
  config: ExchangeConfig & { credentials?: ExchangeCredentials }
  bus: EventBus
  clock: Clock
  logger: Logger
  metrics: PrivateWsMetrics
  wsClientFactory?: BinanceWsClientFactory // kept for backward compat
}

export function createPrivateWsAdapter(opts: CreatePrivateWsAdapterOptions): ExchangePrivateWsAdapter {
  const isDryRun = opts.engineMode === 'dry_run'

  if (isDryRun) {
    return createShadowPrivateWsAdapter(opts.config.exchange)
  }

  const wsOpts = {
    config: opts.config,
    bus: opts.bus,
    clock: opts.clock,
    logger: opts.logger,
    metrics: opts.metrics,
  }

  if (opts.config.exchange === 'binance') {
    return createBinancePrivateWsAdapter({
      ...wsOpts,
      ...(opts.wsClientFactory ? { wsClientFactory: opts.wsClientFactory } : {}),
    })
  }

  if (opts.config.exchange === 'bitget') {
    return createBitgetPrivateWsAdapter(wsOpts)
  }

  if (opts.config.exchange === 'bybit') {
    return createBybitPrivateWsAdapter(wsOpts)
  }

  if (opts.config.exchange === 'okx') {
    return createOkxPrivateWsAdapter(wsOpts)
  }

  if (opts.config.exchange === 'gateio') {
    return createGateioPrivateWsAdapter(wsOpts)
  }

  return createKucoinPrivateWsAdapter(wsOpts)
}
