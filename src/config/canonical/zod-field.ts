import { z } from 'zod'

import type { CanonicalParam } from './params.js'

/** Build the zod schema for one canonical param's numeric value (shared by both generators). */
export function zodNumberFor(param: CanonicalParam, resolvedDefault: number | undefined): z.ZodType<number> {
  let schema = param.unit === 'integer' ? z.number().int() : z.number()

  const hc = param.hardConstraint
  if (hc?.positive) schema = schema.positive()
  if (hc?.min !== undefined) schema = schema.min(hc.min)
  if (hc?.max !== undefined) schema = schema.max(hc.max)

  return resolvedDefault === undefined ? schema : schema.default(resolvedDefault)
}
