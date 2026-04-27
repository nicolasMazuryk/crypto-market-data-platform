import type { Logger } from 'pino'

import type { BalanceEvent, OrderEvent, PositionEvent } from '../adapters/privatews/types.js'
import type { Balance, ExchangeRestAdapter, Order, Position } from '../adapters/rest/types.js'
import type { Clock, EventBus } from '../core/types.js'
import type { StateMetrics } from '../observability/metrics.js'
import type { Exchange, Unsubscribe } from '../types/exchange.js'
import { runReconcile } from './reconcile.js'
import type { DesyncEvent, StateStore } from './types.js'

export interface StateStoreOptions {
  bus: EventBus
  restAdapters: Map<Exchange, ExchangeRestAdapter>
  exchanges: Exchange[]
  clock: Clock
  logger: Logger
  metrics: StateMetrics
}

export interface StateStoreHandle extends StateStore {
  start(): void
  stop(): void
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  let v = map.get(key)
  if (v === undefined) {
    v = init()
    map.set(key, v)
  }
  return v
}

const TERMINAL_STATUSES = new Set(['filled', 'cancelled', 'rejected', 'expired'])

export function createStateStore(opts: StateStoreOptions): StateStoreHandle {
  const { bus, restAdapters, clock, logger, metrics } = opts

  // One-way mode assumed: single position per symbol.
  // TODO: revisit for hedge mode (position key would become (symbol, positionSide))

  const ordersByCid = new Map<Exchange, Map<string, Order>>()
  const openOrderIndex = new Map<Exchange, Set<string>>()
  const positionsBySymbol = new Map<Exchange, Map<string, Position>>()
  const balancesByAsset = new Map<Exchange, Map<string, Balance>>()

  const lastSeq = new Map<Exchange, number>()
  const lastConnState = new Map<Exchange, string>()

  function trackSeq(exchange: Exchange, seq: number): void {
    const last = lastSeq.get(exchange)
    if (last === undefined || seq > last) lastSeq.set(exchange, seq)
  }
  const inFlightReconcile = new Map<Exchange, Promise<void>>()

  const desyncListeners = new Set<(e: DesyncEvent) => void>()
  const busUnsubs: Unsubscribe[] = []

  let seqGen = 0
  function nextSeq(): number {
    return ++seqGen
  }

  function emitDesync(e: DesyncEvent): void {
    metrics.desyncTotal.inc(1, { exchange: e.exchange, kind: e.kind })
    bus.emit('state.desync', e)
    for (const listener of desyncListeners) listener(e)
  }

  function applyOrder(exchange: Exchange, order: Order): void {
    const byCid = getOrCreate(ordersByCid, exchange, () => new Map())
    byCid.set(order.clientOrderId, order)
    const openIdx = getOrCreate(openOrderIndex, exchange, () => new Set())
    if (TERMINAL_STATUSES.has(order.status)) {
      openIdx.delete(order.clientOrderId)
    } else {
      openIdx.add(order.clientOrderId)
    }
    metrics.ordersSize.set(byCid.size, { exchange })
  }

  function applyPosition(exchange: Exchange, position: Position): void {
    const bySymbol = getOrCreate(positionsBySymbol, exchange, () => new Map())
    bySymbol.set(position.symbol, position)
    metrics.positionsSize.set(bySymbol.size, { exchange })
  }

  function applyBalance(exchange: Exchange, balance: Balance): void {
    const byAsset = getOrCreate(balancesByAsset, exchange, () => new Map())
    byAsset.set(balance.asset, balance)
    metrics.balancesSize.set(byAsset.size, { exchange })
  }

  function triggerReconcile(exchange: Exchange): Promise<void> {
    const inflight = inFlightReconcile.get(exchange)
    if (inflight) return inflight

    const rest = restAdapters.get(exchange)
    if (!rest) return Promise.resolve()

    const p = runReconcile({
      exchange,
      rest,
      clock,
      logger,
      metrics,
      getOpenOrderCids: () => new Set(getOrCreate(openOrderIndex, exchange, () => new Set())),
      getOrder: cid => getOrCreate(ordersByCid, exchange, () => new Map<string, Order>()).get(cid),
      getPositions: () => new Map(getOrCreate(positionsBySymbol, exchange, () => new Map())),
      getBalances: () => new Map(getOrCreate(balancesByAsset, exchange, () => new Map())),
      applyOrder: order => {
        applyOrder(exchange, order)
      },
      applyPosition: pos => {
        applyPosition(exchange, pos)
      },
      applyBalance: bal => {
        applyBalance(exchange, bal)
      },
      emitDesync,
      emitSyntheticOrder: (e: OrderEvent) => {
        bus.emit('ws.order', e)
      },
      emitSyntheticPosition: (e: PositionEvent) => {
        bus.emit('ws.position', e)
      },
      emitSyntheticBalance: (e: BalanceEvent) => {
        bus.emit('ws.balance', e)
      },
      nextSeq,
    }).finally(() => {
      inFlightReconcile.delete(exchange)
    })

    inFlightReconcile.set(exchange, p)
    return p
  }

  // Declare store before checkSeqGap so internal calls route through the public
  // reconcile method, which allows vi.spyOn to intercept in tests.
  const store: StateStoreHandle = {
    orders(exchange: Exchange, symbol?: string): Order[] {
      const byCid = ordersByCid.get(exchange)
      if (!byCid) return []
      const all = Array.from(byCid.values())
      return symbol ? all.filter(o => o.symbol === symbol) : all
    },

    positions(exchange: Exchange, symbol?: string): Position[] {
      const bySymbol = positionsBySymbol.get(exchange)
      if (!bySymbol) return []
      const nonFlat = Array.from(bySymbol.values()).filter(p => p.qty > 0)
      return symbol ? nonFlat.filter(p => p.symbol === symbol) : nonFlat
    },

    balances(exchange: Exchange, asset?: string): Balance[] {
      const byAsset = balancesByAsset.get(exchange)
      if (!byAsset) return []
      const all = Array.from(byAsset.values())
      return asset ? all.filter(b => b.asset === asset) : all
    },

    async reconcile(exchange: Exchange): Promise<void> {
      return triggerReconcile(exchange)
    },

    onDesync(listener: (desync: DesyncEvent) => void): Unsubscribe {
      desyncListeners.add(listener)
      return () => desyncListeners.delete(listener)
    },

    start(): void {
      for (const exchange of opts.exchanges) {
        metrics.ordersSize.set(0, { exchange })
        metrics.positionsSize.set(0, { exchange })
        metrics.balancesSize.set(0, { exchange })
      }

      busUnsubs.push(
        bus.on('ws.order', event => {
          applyOrder(event.exchange, event.order)
          checkSeqGap(event.exchange, event.seq)
        })
      )

      busUnsubs.push(
        bus.on('ws.position', event => {
          applyPosition(event.exchange, event.position)
          trackSeq(event.exchange, event.seq)
        })
      )

      busUnsubs.push(
        bus.on('ws.balance', event => {
          applyBalance(event.exchange, event.balance)
          trackSeq(event.exchange, event.seq)
        })
      )

      busUnsubs.push(
        bus.on('ws.connection', event => {
          const prev = lastConnState.get(event.exchange)
          lastConnState.set(event.exchange, event.state)
          if (event.state === 'connected' && prev !== 'connected') {
            void store.reconcile(event.exchange)
          }
        })
      )
    },

    stop(): void {
      for (const unsub of busUnsubs) unsub()
      busUnsubs.length = 0
    },
  }

  function checkSeqGap(exchange: Exchange, seq: number): void {
    const last = lastSeq.get(exchange)
    trackSeq(exchange, seq)
    if (last !== undefined && seq > last + 1) {
      emitDesync({ exchange, kind: 'sequence_gap', details: { expected: last + 1, got: seq }, detectedAt: Date.now() })
      void store.reconcile(exchange)
    }
  }

  return store
}
