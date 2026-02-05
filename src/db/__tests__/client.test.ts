import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { config } from '../../config.js'
import { closeClickHouseClient, getClickHouseClient } from '../client.js'
import { pingClickHouse } from '../health.js'

const database = config.clickhouse.database

describe('ClickHouse client', () => {
  beforeAll(async () => {
    const healthy = await pingClickHouse()
    if (!healthy) {
      throw new Error('ClickHouse is not reachable. Run: npm run db:up')
    }
  })

  afterAll(async () => {
    await closeClickHouseClient()
  })

  it('pings successfully', async () => {
    const client = getClickHouseClient()
    const result = await client.ping()
    const ok = typeof result === 'boolean' ? result : result.success
    expect(ok).toBe(true)
  })

  it('detects the database', async () => {
    const client = getClickHouseClient()
    const result = await client.query({
      query: 'SELECT name FROM system.databases WHERE name = {database: String}',
      query_params: { database },
      format: 'JSONEachRow',
    })
    const rows = await result.json<{ name: string }>()

    expect(rows.length).toBe(1)
    const row = rows[0]
    if (!row) {
      throw new Error('Expected database row')
    }
    expect(row.name).toBe(database)
  })
})
