import type { ProvisioningAdapter, TransferDirection } from './types.js'

export interface ReconcileResult {
  before: number
  after: number
  transferred: number
  direction: TransferDirection | 'none'
}

export interface ReconcileOptions {
  assumedCurrentBalance?: number
}

// Sub-USDT balances are reported with up to 8 decimals; treat anything below
// 1 cent as a no-op rather than chasing dust through a transfer round-trip.
const EPSILON_USDT = 0.01

export async function reconcileCapital(
  adapter: ProvisioningAdapter,
  subAccountId: string,
  targetUsdt: number,
  options: ReconcileOptions = {}
): Promise<ReconcileResult> {
  const before = options.assumedCurrentBalance ?? (await adapter.getSubAccountUsdtBalance(subAccountId))
  const delta = targetUsdt - before

  if (Math.abs(delta) < EPSILON_USDT) {
    return { before, after: before, transferred: 0, direction: 'none' }
  }

  const direction: TransferDirection = delta > 0 ? 'master_to_sub' : 'sub_to_master'
  const amount = Math.abs(delta)
  await adapter.transferUsdt(subAccountId, amount, direction)

  const after = direction === 'master_to_sub' ? before + amount : before - amount
  return { before, after, transferred: amount, direction }
}
