import { getClickHouseClient } from './client.js'

export async function pingClickHouse(): Promise<boolean> {
  const client = getClickHouseClient()

  try {
    const result = await client.ping()
    if (typeof result === 'boolean') {
      return result
    }

    if (result && typeof result === 'object' && 'success' in result) {
      return Boolean((result as { success?: boolean }).success)
    }

    return false
  } catch {
    return false
  }
}

export async function assertClickHouseHealthy(): Promise<void> {
  const healthy = await pingClickHouse()
  if (!healthy) {
    throw new Error('ClickHouse ping failed')
  }
}
