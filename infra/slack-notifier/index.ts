import https from 'node:https'
import { gunzipSync } from 'node:zlib'

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function formatSnsAlarm(rawMessage: string): string {
  let parsed: unknown

  try {
    parsed = JSON.parse(rawMessage)
  } catch {
    return `Alarm notification\nPayload: ${rawMessage}`
  }

  if (!isObject(parsed)) {
    return `Alarm notification\nPayload: ${rawMessage}`
  }

  const alarmName = asString(parsed.AlarmName) ?? 'UnknownAlarm'
  const state = asString(parsed.NewStateValue) ?? 'UNKNOWN'
  const reason = asString(parsed.NewStateReason) ?? 'No reason provided'

  let resource = 'unknown'
  const trigger = parsed.Trigger
  if (isObject(trigger) && Array.isArray(trigger.Dimensions)) {
    for (const dimension of trigger.Dimensions) {
      if (!isObject(dimension)) {
        continue
      }

      const dimensionName = asString(dimension.name)
      const dimensionValue = asString(dimension.value)
      if (!dimensionName || !dimensionValue) {
        continue
      }

      if (['InstanceId', 'ClusterName', 'ServiceName'].includes(dimensionName)) {
        resource = dimensionValue
        break
      }
    }
  }

  return [
    `Alarm: ${alarmName}`,
    `State: ${state}`,
    `Resource: ${resource}`,
    `Reason: ${reason}`,
  ].join('\n')
}

function parseWorkerErrors(data: string): string[] {
  let parsed: unknown

  try {
    const unzipped = gunzipSync(Buffer.from(data, 'base64')).toString('utf8')
    parsed = JSON.parse(unzipped)
  } catch {
    return []
  }

  if (!isObject(parsed) || !Array.isArray(parsed.logEvents)) {
    return []
  }

  const logGroup = asString(parsed.logGroup) ?? 'unknown'
  const logStream = asString(parsed.logStream) ?? 'unknown'

  return parsed.logEvents
    .map((entry) => {
      if (!isObject(entry)) {
        return null
      }

      const message = asString(entry.message)
      if (!message || message.trim().length === 0) {
        return null
      }

      return [
        'Worker Error',
        `LogGroup: ${logGroup}`,
        `LogStream: ${logStream}`,
        `Message: ${message.trim()}`,
      ].join('\n')
    })
    .filter((message): message is string => message !== null)
}

async function postToSlack(webhookUrl: string, text: string): Promise<void> {
  const payload = JSON.stringify({ text })
  const url = new URL(webhookUrl)

  await new Promise<void>((resolve, reject) => {
    const request = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        let body = ''

        response.on('data', (chunk) => {
          body += String(chunk)
        })

        response.on('end', () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve()
            return
          }

          reject(
            new Error(
              `Slack webhook request failed: ${response.statusCode ?? 'unknown'} ${body}`
            )
          )
        })
      }
    )

    request.on('error', reject)
    request.write(payload)
    request.end()
  })
}

function collectMessages(event: unknown): string[] {
  const messages: string[] = []

  if (isObject(event) && Array.isArray(event.Records)) {
    for (const record of event.Records) {
      if (!isObject(record)) {
        continue
      }

      const source = asString(record.EventSource)
      if (source !== 'aws:sns') {
        continue
      }

      const sns = record.Sns
      if (!isObject(sns)) {
        continue
      }

      const message = asString(sns.Message)
      if (!message) {
        continue
      }

      messages.push(formatSnsAlarm(message))
    }
  }

  if (isObject(event) && isObject(event.awslogs)) {
    const data = asString(event.awslogs.data)
    if (data) {
      messages.push(...parseWorkerErrors(data))
    }
  }

  return messages
}

export async function handler(event: unknown): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    console.warn('SLACK_WEBHOOK_URL is not configured; skipping notification')
    return
  }

  const messages = collectMessages(event)
  if (messages.length === 0) {
    console.info('Received event with no Slack messages to send')
    return
  }

  for (const message of messages) {
    await postToSlack(webhookUrl, message)
  }
}
