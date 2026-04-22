import { createClient, type ClickHouseClient } from '@clickhouse/client'

import { config } from '../config.js'

let client: ClickHouseClient | null = null

export function getClickHouseClient(): ClickHouseClient {
  if (!client) {
    const { host, httpPort, database, user, password } = config.clickhouse
    client = createClient({
      url: `http://${host}:${httpPort}`,
      database,
      username: user,
      password,
      request_timeout: 600_000,
    })
  }

  return client
}

export async function closeClickHouseClient(): Promise<void> {
  if (!client) {
    return
  }

  await client.close()
  client = null
}
