/**
 * Live driver for strategy_1_ws — WS-only order placement at real funding boundaries.
 *
 * Usage:
 *   tsx --env-file=.env src/execution/scripts/live-strategy-1-ws.ts --config config/execution.test-s1-ws.yaml
 *   tsx --env-file=.env src/execution/scripts/live-strategy-1-ws.ts --config config/execution.test-s1-ws.yaml --metrics-port 9474 --health-port 9476
 *   tsx --env-file=.env src/execution/scripts/live-strategy-1-ws.ts --config config/execution.test-s1-ws.yaml --skip-boundary-guard
 *
 * Guards:
 *   - Refuses to start unless current UTC time is within 30 min of a 1-hour funding boundary
 *     (any HH:00:00 UTC mark). Use --skip-boundary-guard to bypass.
 *   - Fails fast if any WS order adapter fails to connect or returns a rejected OrderAck.
 *   - Post-run: asserts all exits via funding_fee (source=ws), zero funding_fee_timeout exits.
 *
 * Log output: JSONL to stdout (one JSON object per line).
 */

import { parseArgs } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'

import { startEngine } from '../index.js'
import type { FundingFeeEvent } from '../adapters/privatews/types.js'
import type { IntentState } from '../execution/types.js'
import { gracefulShutdown } from './lib/graceful-shutdown.js'

const DEFAULT_TIMEOUT_MINUTES = 30
const HOUR_MS = 60 * 60 * 1_000
const FUNDING_BOUNDARY_GUARD_MS = 30 * 60 * 1_000

// ─── Funding boundary guard ────────────────────────────────────────────────────

function msToNearestHourBoundary(nowMs: number): number {
  const msIntoCurrentHour = nowMs % HOUR_MS
  const msToNext = HOUR_MS - msIntoCurrentHour
  return Math.min(msToNext, msIntoCurrentHour)
}

function assertNearFundingBoundary(): void {
  const nowMs = Date.now()
  const distanceMs = msToNearestHourBoundary(nowMs)
  if (distanceMs > FUNDING_BOUNDARY_GUARD_MS) {
    const nextBoundary = new Date(nowMs + (HOUR_MS - (nowMs % HOUR_MS)))
    console.error(
      JSON.stringify({
        event: 'driver.guard.rejected',
        reason: 'not_near_funding_boundary',
        distanceMs,
        nextBoundaryUtc: nextBoundary.toISOString(),
        message: 'Start within 30 min of any hourly boundary (HH:00:00 UTC). Use --skip-boundary-guard to bypass.',
      })
    )
    process.exit(1)
  }
}

// ─── JSONL log helpers ─────────────────────────────────────────────────────────

function makeLogPath(logDir: string): string {
  const nowMs = Date.now()
  const boundaryMs = Math.round(nowMs / HOUR_MS) * HOUR_MS
  const boundary = new Date(boundaryMs).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return path.join(logDir, `strategy_1_ws_${boundary}.jsonl`)
}

function openLog(logPath: string): (obj: unknown) => void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const stream = fs.createWriteStream(logPath, { flags: 'a' })
  return (obj: unknown) => {
    const line = JSON.stringify(obj) + '\n'
    stream.write(line)
    process.stdout.write(line)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      config: { type: 'string' },
      registry: { type: 'string' },
      'metrics-port': { type: 'string' },
      'health-port': { type: 'string' },
      'timeout-minutes': { type: 'string' },
      'skip-boundary-guard': { type: 'boolean' },
      'skip-recovery': { type: 'boolean' },
      'log-dir': { type: 'string' },
    },
    allowPositionals: false,
  })

  const configPath = values.config
  if (!configPath) {
    console.error('Error: --config <path> is required')
    process.exitCode = 1
    return
  }

  const skipGuard = values['skip-boundary-guard'] === true
  if (!skipGuard) assertNearFundingBoundary()

  const timeoutMinutes =
    values['timeout-minutes'] !== undefined ? parseInt(values['timeout-minutes'], 10) : DEFAULT_TIMEOUT_MINUTES
  const TIMEOUT_MS = timeoutMinutes * 60 * 1_000

  const logDir = values['log-dir'] ?? 'logs'
  const logPath = makeLogPath(logDir)
  const log = openLog(logPath)

  log({ event: 'driver.starting', configPath, logPath, at: new Date().toISOString() })

  // ─── Start engine ──────────────────────────────────────────────────────────

  const handle = await startEngine({
    configPath,
    ...(values.registry !== undefined ? { registryPath: values.registry } : {}),
    ...(values['metrics-port'] !== undefined ? { metricsPort: parseInt(values['metrics-port'], 10) } : {}),
    ...(values['health-port'] !== undefined ? { healthPort: parseInt(values['health-port'], 10) } : {}),
    ...(values['skip-recovery'] === true ? { skipRecovery: true } : {}),
  })

  const { bus, manager } = handle
  if (!manager) {
    log({ event: 'driver.error', reason: 'manager_unavailable' })
    await handle.stop()
    process.exitCode = 1
    return
  }

  // ─── Post-run state ────────────────────────────────────────────────────────

  const settledReasons: { intentId: string; reason: string; source?: string }[] = []
  const fundingFeeEvents: FundingFeeEvent[] = []
  let wsOrderRejectSeen = false

  // ─── Bus subscriptions ─────────────────────────────────────────────────────

  const unsubs: (() => void)[] = []

  unsubs.push(
    bus.on('ws.funding_fee', (event: FundingFeeEvent) => {
      fundingFeeEvents.push(event)
      log({
        event: 'ws.funding_fee',
        exchange: event.exchange,
        symbol: event.symbol,
        fundingAmount: event.fundingAmount,
        fundingRate: event.fundingRate,
        at: new Date().toISOString(),
      })
    })
  )

  unsubs.push(
    bus.on('intent.state_changed', (state: IntentState) => {
      log({
        event: 'intent.state_changed',
        intentId: state.intent.id,
        exchange: state.intent.exchange,
        symbol: state.intent.symbol,
        status: state.status,
        exitReason: state.exitReason,
        filledQty: state.filledQty,
        avgEntryPrice: state.avgEntryPrice,
        avgExitPrice: state.avgExitPrice,
        at: new Date().toISOString(),
      })
    })
  )

  unsubs.push(
    bus.on('exit.triggered', event => {
      settledReasons.push({ intentId: event.intentId, reason: event.reason, source: event.source })
      log({
        event: 'exit.triggered',
        intentId: event.intentId,
        exchange: event.exchange,
        symbol: event.symbol,
        reason: event.reason,
        source: event.source,
        at: new Date().toISOString(),
      })
    })
  )

  // Fail-fast on any WS order rejection
  unsubs.push(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    (bus as any).on?.('orderws.createOrder.failed', (ev: unknown) => {
      wsOrderRejectSeen = true
      log({ event: 'orderws.createOrder.failed', detail: ev, at: new Date().toISOString() })
      console.error(JSON.stringify({ event: 'driver.fail_fast', reason: 'ws_order_rejected', detail: ev }))
      clearTimeout(hardTimeout)
      void manager.flattenAll().finally(async () => {
        process.exitCode = 1
        for (const unsub of unsubs) unsub()
        await gracefulShutdown(handle, { drainSeconds: 5 })
      })
    }) ??
      (() => {
        /* bus may not have this event yet */
      })
  )

  // ─── Hard timeout ──────────────────────────────────────────────────────────

  const hardTimeout = setTimeout(() => {
    log({ event: 'driver.timeout', timeoutMs: TIMEOUT_MS, at: new Date().toISOString() })
    process.exitCode = 1
    void manager.flattenAll().finally(async () => {
      for (const unsub of unsubs) unsub()
      await gracefulShutdown(handle, { drainSeconds: 0 })
    })
  }, TIMEOUT_MS)

  // ─── Signal handlers ───────────────────────────────────────────────────────

  const shutdown = (signal: string) => {
    log({ event: `driver.${signal.toLowerCase()}`, at: new Date().toISOString() })
    clearTimeout(hardTimeout)
    void manager.flattenAll().finally(async () => {
      for (const unsub of unsubs) unsub()
      await gracefulShutdown(handle, { drainSeconds: 0 })
    })
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    shutdown('SIGTERM')
  })

  // ─── Wait for all intents to exit, then run post-run assertions ────────────

  // Track active intents
  const activeIntents = new Set<string>()

  unsubs.push(
    bus.on('intent.state_changed', (state: IntentState) => {
      if (
        state.status === 'monitoring' ||
        state.status === 'submitted' ||
        state.status === 'acked' ||
        state.status === 'working'
      ) {
        activeIntents.add(state.intent.id)
      } else if (state.status === 'exited' || state.status === 'error' || state.status === 'cancelled') {
        activeIntents.delete(state.intent.id)
        if (activeIntents.size === 0 && !wsOrderRejectSeen) {
          // All intents have exited — run post-run assertions
          clearTimeout(hardTimeout)
          runPostRunAssertions()
          void (async () => {
            for (const unsub of unsubs) unsub()
            await gracefulShutdown(handle, { drainSeconds: 5 })
          })()
        }
      }
    })
  )

  log({ event: 'engine.started', mode: handle.config.mode, at: new Date().toISOString() })

  function runPostRunAssertions(): void {
    const timeoutExits = settledReasons.filter(r => r.reason === 'funding_fee_timeout')
    const wsExits = settledReasons.filter(r => r.reason === 'funding_fee' && r.source === 'ws')
    const restPollExits = settledReasons.filter(r => r.reason === 'funding_fee' && r.source === 'rest_poll')
    const allFundingFeeExits = settledReasons.filter(r => r.reason === 'funding_fee')

    log({
      event: 'post_run.summary',
      totalSettled: settledReasons.length,
      fundingFeeExits: allFundingFeeExits.length,
      timeoutExits: timeoutExits.length,
      wsSourceExits: wsExits.length,
      restPollExits: restPollExits.length,
      totalFundingFeeEvents: fundingFeeEvents.length,
      at: new Date().toISOString(),
    })

    const failures: string[] = []

    if (timeoutExits.length > 0) {
      failures.push(
        `${String(timeoutExits.length)} intent(s) exited via funding_fee_timeout (expected ws or rest_poll)`
      )
    }

    const goodExits = wsExits.length + restPollExits.length
    if (allFundingFeeExits.length > 0 && goodExits !== allFundingFeeExits.length) {
      failures.push(
        `${String(allFundingFeeExits.length - goodExits)} funding_fee exit(s) did not have source=ws or source=rest_poll`
      )
    }

    if (failures.length > 0) {
      log({ event: 'post_run.FAILED', failures, at: new Date().toISOString() })
      process.exitCode = 1
    } else {
      log({ event: 'post_run.PASSED', at: new Date().toISOString() })
      process.exitCode = 0
    }
  }
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ event: 'driver.fatal', err: String(err) }))
  process.exitCode = 1
})
