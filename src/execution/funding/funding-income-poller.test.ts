import { describe, expect, it, vi } from 'vitest'

import { createEventBus } from '../core/bus.js'
import type { ExchangeRestAdapter, FundingIncomeRecord } from '../adapters/rest/types.js'
import type { ExecutionManager } from '../execution/types.js'
import { createFundingIncomePoller } from './funding-income-poller.js'

function makeAdapter(exchange: ExchangeRestAdapter['exchange'], record: FundingIncomeRecord | null): ExchangeRestAdapter {
  return {
    exchange,
    setLeverage: vi.fn(),
    setMarginMode: vi.fn(),
    setPositionMode: vi.fn(),
    createOrder: vi.fn(),
    cancelOrder: vi.fn(),
    amendOrder: vi.fn(),
    getOpenOrders: vi.fn(),
    getOrder: vi.fn(),
    getPositions: vi.fn(),
    getBalance: vi.fn(),
    getServerTime: vi.fn(),
    fetchFundingFeeIncome: vi.fn().mockResolvedValue(record),
  } as unknown as ExchangeRestAdapter
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as never

describe('createFundingIncomePoller', () => {
  it('polls every adapter with fetchFundingFeeIncome for matching open intents', async () => {
    const bus = createEventBus()
    const emitted: unknown[] = []
    bus.on('ws.funding_fee', event => emitted.push(event))
    const binance = makeAdapter('binance', {
      symbol: 'BTCUSDT',
      fundingTime: 1_700_000_000_000,
      fundingAmount: -0.1,
      asset: 'USDT',
    })
    const okx = makeAdapter('okx', {
      symbol: 'EDENUSDT',
      fundingTime: 1_700_000_000_000,
      fundingAmount: 0.05,
      asset: 'USDT',
    })
    const execManager = {
      listRecentIntentsForAttribution: () => [
        { intentId: 'binance-intent', exchange: 'binance', symbol: 'BTCUSDT' },
        { intentId: 'okx-intent', exchange: 'okx', symbol: 'EDENUSDT' },
      ],
    } as unknown as ExecutionManager

    const poller = createFundingIncomePoller({
      restAdapters: new Map([
        ['binance', binance],
        ['okx', okx],
      ]),
      execManager,
      bus,
      logger,
      now: () => 1_700_000_003_000,
    })

    await poller.tick()

    expect(binance.fetchFundingFeeIncome).toHaveBeenCalledWith('BTCUSDT', 1_699_999_200_000)
    expect(okx.fetchFundingFeeIncome).toHaveBeenCalledWith('EDENUSDT', 1_699_999_200_000)
    expect(emitted).toHaveLength(2)
    expect(emitted).toContainEqual(expect.objectContaining({ exchange: 'okx', symbol: 'EDENUSDT', fundingAmount: 0.05 }))
  })

  it('logs not_found without emitting when an adapter has no funding record', async () => {
    const bus = createEventBus()
    const emitted: unknown[] = []
    bus.on('ws.funding_fee', event => emitted.push(event))
    const okx = makeAdapter('okx', null)
    const execManager = {
      listRecentIntentsForAttribution: () => [{ intentId: 'okx-intent', exchange: 'okx', symbol: 'EDENUSDT' }],
    } as unknown as ExecutionManager

    const poller = createFundingIncomePoller({
      restAdapters: new Map([['okx', okx]]),
      execManager,
      bus,
      logger,
      now: () => 1_700_000_003_000,
    })

    await poller.tick()

    expect(emitted).toHaveLength(0)
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'funding_income_poller.not_found', intentId: 'okx-intent' }),
      'funding_income_poller.not_found'
    )
  })
})
