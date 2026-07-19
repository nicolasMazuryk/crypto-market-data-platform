import { z } from 'zod'

import type { StrategyId } from '../../execution/strategies/types.js'
import type { CanonicalParam } from './params.js'
import { boundsFor } from './params.js'

/** Build the zod schema for one canonical param's numeric value (shared by both generators). */
export function zodNumberFor(
  param: CanonicalParam,
  resolvedDefault: number | undefined,
  strategyId?: StrategyId
): z.ZodType<number> {
  let schema = param.unit === 'integer' ? z.number().int() : z.number()

  const hc = param.hardConstraint
  if (hc?.positive) schema = schema.positive()
  if (hc?.min !== undefined) schema = schema.min(hc.min)
  if (hc?.max !== undefined) schema = schema.max(hc.max)

  const bounds = boundsFor(param, strategyId)
  if (bounds?.min !== undefined) schema = bounds.exclusiveMin ? schema.gt(bounds.min) : schema.min(bounds.min)
  if (bounds?.max !== undefined) schema = bounds.exclusiveMax ? schema.lt(bounds.max) : schema.max(bounds.max)

  return resolvedDefault === undefined ? schema : schema.default(resolvedDefault)
}
