import type { Logger } from 'pino'

import type { ConnectionStateEvent } from '../adapters/privatews/types.js'
import type { EventBus, OpsEventPayload } from '../core/types.js'

export type AlertSeverity = 'page' | 'notify'

export interface AlertDispatcher {
  dispatch(severity: AlertSeverity, event: string, fields?: Record<string, unknown>): Promise<void>
  subscribeToDisconnects(bus: EventBus, thresholdMs?: number): () => void
  subscribeToBusOpsEvents(bus: EventBus): () => void
}

export interface AlertDispatcherOptions {
  slackWebhookUrl: string | undefined
  pageChannel?: string
  notifyChannel?: string
  logger: Logger
}

function buildSlackText(severity: AlertSeverity, event: string, fields?: Record<string, unknown>): string {
  const ts = new Date().toISOString()
  const icon = severity === 'page' ? ':fire:' : ':warning:'
  const tag = severity === 'page' ? 'PAGE' : 'NOTIFY'
  const mention = severity === 'page' ? '<!channel> ' : ''
  const lines: string[] = [`${mention}${icon} *[${tag}] ${event}*`, `• *time:* ${ts}`]
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) lines.push(`• *${k}:* ${JSON.stringify(v)}`)
    }
  }
  return lines.join('\n')
}

export function createAlertDispatcher(opts: AlertDispatcherOptions): AlertDispatcher {
  const { slackWebhookUrl, pageChannel = '#alerts-page', notifyChannel = '#alerts', logger } = opts

  async function dispatch(severity: AlertSeverity, event: string, fields?: Record<string, unknown>): Promise<void> {
    logger.info({ severity, event, ...fields }, 'alert.dispatch')

    if (!slackWebhookUrl) {
      logger.warn({ severity, event }, 'alert.no_webhook')
      return
    }

    const text = buildSlackText(severity, event, fields)
    const channel = severity === 'page' ? pageChannel : notifyChannel

    try {
      const res = await fetch(slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, channel }),
      })
      if (!res.ok) {
        logger.error({ severity, event, status: res.status }, 'alert.failed')
      }
    } catch (err) {
      logger.error({ err, severity, event }, 'alert.error')
    }
  }

  return {
    dispatch,

    subscribeToDisconnects(bus: EventBus, thresholdMs = 30_000): () => void {
      const disconnectStart = new Map<string, number>()
      const alerted = new Set<string>()

      const onConnection = (event: ConnectionStateEvent): void => {
        const { exchange, state } = event
        const isDown = state === 'disconnected' || state === 'reconnecting' || state === 'fatal'
        if (isDown) {
          if (!disconnectStart.has(exchange)) disconnectStart.set(exchange, Date.now())
        } else if (state === 'connected') {
          disconnectStart.delete(exchange)
          alerted.delete(exchange)
        }
      }

      const timer = setInterval(() => {
        const now = Date.now()
        for (const [exchange, start] of disconnectStart) {
          const durationMs = now - start
          if (durationMs >= thresholdMs && !alerted.has(exchange)) {
            alerted.add(exchange)
            void dispatch('page', 'adapter.broker_disconnect', { exchange, durationMs })
          }
        }
      }, 5_000)

      const unsub = bus.on('ws.connection', onConnection)
      return (): void => {
        clearInterval(timer)
        unsub()
      }
    },

    subscribeToBusOpsEvents(bus: EventBus): () => void {
      const onOps = (event: OpsEventPayload): void => {
        if (event.level === 'fatal' || event.level === 'error') {
          void dispatch('page', `ops.${event.eventType}`, {
            ...(event.exchange ? { exchange: event.exchange } : {}),
            ...(event.payload !== undefined ? { payload: event.payload } : {}),
          })
        } else if (event.level === 'warn') {
          void dispatch('notify', `ops.${event.eventType}`, {
            ...(event.exchange ? { exchange: event.exchange } : {}),
            ...(event.payload !== undefined ? { payload: event.payload } : {}),
          })
        }
      }

      return bus.on('ops.event', onOps)
    },
  }
}
