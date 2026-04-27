import { parseArgs } from 'node:util'

import { createExecutionLogger } from '../core/logger.js'
import { createAlertDispatcher } from '../observability/alerts.js'

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      severity: { type: 'string', default: 'notify' },
      message: { type: 'string', default: 'smoke test from alerts:test' },
    },
  })

  const severity = values.severity === 'page' ? 'page' : ('notify' as const)
  const message = values.message

  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!slackWebhookUrl) {
    console.error('error: SLACK_WEBHOOK_URL env var is not set')
    process.exitCode = 1
    return
  }

  const logger = createExecutionLogger()
  const dispatcher = createAlertDispatcher({ slackWebhookUrl, logger })

  logger.info({ severity, message }, 'test-alerts: dispatching')
  await dispatcher.dispatch(severity, 'test.smoke', { message, host: process.env.HOSTNAME })
  logger.info('test-alerts: ok')
}

main().catch((err: unknown) => {
  console.error('fatal', err)
  process.exitCode = 1
})
