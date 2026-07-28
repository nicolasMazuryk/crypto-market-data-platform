import { readFileSync } from 'fs'
import * as os from 'os'
import { parse } from 'yaml'
import { z } from 'zod'

import type { ChartConfig } from './types.js'

const DateRangeSchema = z
  .object({
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
  })
  .optional()

const ChartConfigSchema = z.object({
  funding_rate_threshold: z.number(),
  threshold_mode: z.enum(['lte', 'gte', 'abs_gte']).default('lte'),
  exchanges: z.array(z.string()).default([]),
  symbols: z.array(z.string()).default([]),
  date_range: DateRangeSchema,
  pre_seconds: z.number().int().positive().default(30),
  post_seconds: z.number().int().positive().default(180),
  output_dir: z.string().default('./out'),
  image_width: z.number().int().positive().default(1920),
  image_height: z.number().int().positive().default(900),
  overwrite: z.boolean().default(false),
  worker_count: z.number().int().positive().nullable().default(null),
  db_concurrency_per_worker: z.number().int().positive().default(4),
  show_fib_ladder: z.boolean().default(true),
  show_spread_shade: z.boolean().default(false),
})

export interface LoadConfigOverrides {
  workers?: number
  outputDir?: string
  preSeconds?: number
  postSeconds?: number
}

export function loadConfig(configPath: string, overrides: LoadConfigOverrides = {}): ChartConfig {
  const raw = readFileSync(configPath, 'utf8')
  const parsed: unknown = parse(raw)
  const validated = ChartConfigSchema.parse(parsed)

  const resolvedWorkers = overrides.workers ?? validated.worker_count ?? os.cpus().length

  return {
    funding_rate_threshold: validated.funding_rate_threshold,
    threshold_mode: validated.threshold_mode,
    exchanges: validated.exchanges,
    symbols: validated.symbols,
    date_range: {
      from: validated.date_range?.from ?? null,
      to: validated.date_range?.to ?? null,
    },
    pre_seconds: overrides.preSeconds ?? validated.pre_seconds,
    post_seconds: overrides.postSeconds ?? validated.post_seconds,
    output_dir: overrides.outputDir ?? validated.output_dir,
    image_width: validated.image_width,
    image_height: validated.image_height,
    overwrite: validated.overwrite,
    worker_count: resolvedWorkers,
    db_concurrency_per_worker: validated.db_concurrency_per_worker,
    show_fib_ladder: validated.show_fib_ladder,
    show_spread_shade: validated.show_spread_shade,
  }
}
