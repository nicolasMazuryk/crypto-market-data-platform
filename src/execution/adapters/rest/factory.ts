import type { Logger } from 'pino'

import type { Clock, ClientOrderIdDeriver, RateLimiter, EventBus } from '../../core/types.js'
import type { ExchangeConfig } from '../../config/types.js'
import type { RestMetrics } from '../../observability/metrics.js'
import type { Tracer } from '../../observability/types.js'
import type { CcxtExchange } from '../../../exchanges/types.js'
import type { MarketMetadataProvider } from '../../markets/types.js'
import type { ExchangeRestAdapter } from './types.js'
import { createBinanceRestAdapter } from './binance.js'
import { createBitgetRestAdapter } from './bitget.js'
import { createBybitRestAdapter } from './bybit.js'
import { createOkxRestAdapter } from './okx.js'
import { createGateioRestAdapter } from './gateio.js'
import { createKucoinRestAdapter } from './kucoin.js'
import { createShadowRestAdapter } from './shadow.js'

export interface CreateRestAdapterOptions {
  engineMode: 'live' | 'dry_run'
  config: ExchangeConfig
  limiter: RateLimiter
  clock: Clock
  ids: ClientOrderIdDeriver
  logger: Logger
  metrics: RestMetrics
  bus?: EventBus
  marketMetadataProvider?: MarketMetadataProvider
  ccxtFactory?: () => CcxtExchange
  tracer?: Tracer
  shadowFillDelayMs?: number
}

export function createRestAdapter(opts: CreateRestAdapterOptions): ExchangeRestAdapter {
  const isDryRun = opts.engineMode === 'dry_run'

  if (isDryRun) {
    return createShadowRestAdapter({
      exchange: opts.config.exchange,
      clock: opts.clock,
      logger: opts.logger,
      metrics: opts.metrics,
      ...(opts.bus !== undefined ? { bus: opts.bus } : {}),
      ...(opts.shadowFillDelayMs !== undefined ? { fillDelayMs: opts.shadowFillDelayMs } : {}),
    })
  }

  const baseOpts = {
    config: opts.config,
    limiter: opts.limiter,
    clock: opts.clock,
    ids: opts.ids,
    logger: opts.logger,
    metrics: opts.metrics,
    ...(opts.marketMetadataProvider !== undefined ? { marketMetadataProvider: opts.marketMetadataProvider } : {}),
    ...(opts.ccxtFactory !== undefined ? { ccxtFactory: opts.ccxtFactory } : {}),
    ...(opts.tracer !== undefined ? { tracer: opts.tracer } : {}),
  }

  if (opts.config.exchange === 'binance') {
    return createBinanceRestAdapter(baseOpts)
  }

  if (opts.config.exchange === 'bitget') {
    return createBitgetRestAdapter(baseOpts)
  }

  if (opts.config.exchange === 'bybit') {
    return createBybitRestAdapter(baseOpts)
  }

  if (opts.config.exchange === 'okx') {
    return createOkxRestAdapter(baseOpts)
  }

  if (opts.config.exchange === 'gateio') {
    return createGateioRestAdapter(baseOpts)
  }

  return createKucoinRestAdapter(baseOpts)
}
