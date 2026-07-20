/**
 * Canonical terminal-state enums shared by the backtest and live engines.
 *
 * Single source of truth for §12.1 `exit_reason` and §12.2 `error_code`, mirroring how
 * `params.ts` owns the canonical numeric params. Both engines import from here so their
 * emitted terminal-state distributions are directly comparable (§12.2 mandate: "a backtest
 * run must emit these same enums").
 *
 * Spec: docs-strategy/strategies/00_globals.md §12.1 (280–291), §12.2 (292–301).
 */

/** §12.1 exit_reason registry — a position reaching a normal terminal state. */
export const EXIT_REASONS = [
  'timed',
  'funding_fee_event',
  'funding_fee_timeout',
  'tp_hit',
  'sl_hit',
  'deadline',
  'kill_switch_flatten',
] as const

export type ExitReason = (typeof EXIT_REASONS)[number]

/** §12.2 error_code registry — a representable terminal reached via a failure/no-fill path. */
export const ERROR_CODES = [
  'kill_switch',
  'limit_expired',
  'ladder_no_fills',
  'pre_funding_order_failed',
  'pre_funding_order_rejected',
  'pre_funding_not_filled',
  'funding_event_timeout',
  'main_order_failed',
  'main_order_rejected',
  'close_pre_funding_failed',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** Type guard: `value` is one of the §12.1 canonical exit reasons. */
export function isExitReason(value: unknown): value is ExitReason {
  return typeof value === 'string' && (EXIT_REASONS as readonly string[]).includes(value)
}

/** Type guard: `value` is one of the §12.2 canonical error codes. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}
