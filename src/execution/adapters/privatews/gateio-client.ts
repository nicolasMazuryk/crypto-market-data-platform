import { makeTypedEmitter } from './binance-client.js'
import type { PrivateWsClient, PrivateWsClientEvents } from './private-ws-base.js'

export interface GateioWsCredentials {
  apiKey: string
  apiSecret: string
}

export interface GateioWsClientOptions {
  credentials?: GateioWsCredentials
  wsBaseUrl?: string
}

// GateIO futures WS does not have a futures.account_book channel.
// We poll the REST account_book endpoint for fund-type entries instead.
const ACCTBOOK_POLL_MS = 2_000

export function createGateioWsClient(opts: GateioWsClientOptions): PrivateWsClient {
  const emitter = makeTypedEmitter<PrivateWsClientEvents>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdkClient: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let restClient: any = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let lastFundingTime = 0

  function startFundingPoll(): void {
    if (!restClient) return
    if (pollTimer) return
    pollTimer = setInterval(() => {
      void (async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          const entries = await restClient.getFuturesAccountBook({
            settle: 'usdt',
            type: 'fund',
            limit: 100,
          }) as Array<{ time: number; contract?: string; change?: string; change_type?: string; currency?: string }>

          const newEntries = entries.filter(e => e.time > lastFundingTime)
          if (newEntries.length === 0) return

          // Advance the cursor
          const maxTime = Math.max(...newEntries.map(e => e.time))
          lastFundingTime = maxTime

          // Fetch funding rate for each unique contract so parseGateioMessage can stamp it.
          // Augment entries with funding rate fetched from REST history (listFuturesFundingRateHistory).
          const contractsToFetch = [...new Set(newEntries.map(e => e.contract).filter((c): c is string => Boolean(c)))]
          const rateByContract: Record<string, number> = {}
          for (const contract of contractsToFetch) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
              const rates = await restClient.listFuturesFundingRateHistory({
                settle: 'usdt',
                contract,
                limit: 5,
              }) as Array<{ contract?: string; t?: number; r?: string }>
              if (rates.length > 0) {
                const r = parseFloat(rates[0]?.r ?? '0')
                if (!isNaN(r)) rateByContract[contract] = r
              }
            } catch {
              // ignore — rate stays 0 for this contract
            }
          }

          // Emit as a synthetic futures.account_book WS message so parseGateioMessage handles it.
          // REST API uses 'type' field; WS (and parseGateioMessage) expects 'change_type'.
          const message = {
            channel: 'futures.account_book',
            event: 'update',
            result: newEntries.map((e: Record<string, unknown>) => ({
              ...e,
              change_type: e['type'],
              funding_rate: rateByContract[String(e['contract'] ?? '')] ?? 0,
            })),
          }
          if (process.env.GATEIO_ACCTBOOK_DEBUG === '1') {
            process.stdout.write(JSON.stringify({ _debug: 'gateio.acctbook_poll', count: newEntries.length, entries: newEntries }) + '\n')
          }
          emitter.emit('message', message)
        } catch {
          // ignore REST errors — will retry next interval
        }
      })()
    }, ACCTBOOK_POLL_MS)
  }

  function stopFundingPoll(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  return {
    async connect(): Promise<void> {
      const { WebsocketClient, RestClient } = await import('gateio-api')
      const clientOpts: Record<string, unknown> = {}
      if (opts.credentials) {
        clientOpts.apiKey = opts.credentials.apiKey
        clientOpts.apiSecret = opts.credentials.apiSecret
      }
      if (opts.wsBaseUrl) clientOpts.wsUrl = opts.wsBaseUrl

      sdkClient = new WebsocketClient(clientOpts as ConstructorParameters<typeof WebsocketClient>[0])

      if (opts.credentials) {
        restClient = new RestClient({
          apiKey: opts.credentials.apiKey,
          apiSecret: opts.credentials.apiSecret,
        })
        // Seed lastFundingTime to now so we only see NEW funding entries going forward
        lastFundingTime = Math.floor(Date.now() / 1000)
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      sdkClient.on('exception', (err: any) => {
        if (process.env.GATEIO_ACCTBOOK_DEBUG === '1') {
          process.stdout.write(JSON.stringify({ _debug: 'gateio.exception', err: String(err) }) + '\n')
        }
        const e = err instanceof Error ? err : new Error(String(err))
        emitter.emit('error', e)
      })
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      sdkClient.on('close', () => {
        if (process.env.GATEIO_ACCTBOOK_DEBUG === '1') {
          process.stdout.write(JSON.stringify({ _debug: 'gateio.close' }) + '\n')
        }
        emitter.emit('close', 'connection closed')
      })
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      sdkClient.on('response', (data: unknown) => {
        if (process.env.GATEIO_ACCTBOOK_DEBUG === '1') {
          process.stdout.write(JSON.stringify({ _debug: 'gateio.response', data }) + '\n')
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      sdkClient.on('update', (data: unknown) => {
        if (process.env.GATEIO_ACCTBOOK_DEBUG === '1') {
          const ch = (data as Record<string, unknown>)['channel'] ?? 'unknown'
          process.stdout.write(JSON.stringify({ _debug: 'gateio.raw_update', channel: ch }) + '\n')
        }
        emitter.emit('message', data)
      })

      // gateio-api SDK: subscribe with payload ['!all'] to receive all-contract private events.
      // 'perpFuturesUSDTV4' = USDT-margined perps.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      sdkClient.subscribe({ topic: 'futures.orders', payload: ['!all'] }, 'perpFuturesUSDTV4')
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      sdkClient.subscribe({ topic: 'futures.positions', payload: ['!all'] }, 'perpFuturesUSDTV4')
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      sdkClient.subscribe({ topic: 'futures.balances', payload: [] }, 'perpFuturesUSDTV4')

      // futures.account_book does not exist on the GateIO perp futures WS.
      // Funding fees are detected via REST polling in startFundingPoll().
      startFundingPoll()
    },

    async disconnect(): Promise<void> {
      stopFundingPoll()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const client = sdkClient
      sdkClient = null
      restClient = null
      if (client) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          client.removeAllListeners()
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          await client.closeAll(true)
        } catch {
          // ignore
        }
      }
    },

    events: emitter,
  }
}
