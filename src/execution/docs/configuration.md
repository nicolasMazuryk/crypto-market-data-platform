# Configuration

How the execution engine is configured, validated, and extended.

Source: `src/execution/config/`
- `schema.ts` — Zod schemas + `parseEngineConfig()` (structural + semantic validation)
- `loader.ts` — YAML loading, base-merge, env-var injection, CLI overrides
- `types.ts` — TypeScript interfaces (`EngineConfig` and subtypes)
- `schema.test.ts` — unit tests for semantic validation rules

## Directory Layout

```
config/
├── execution.base.yaml      # Shared settings (exchanges, scheduler, persistence, observability)
├── execution.dry-run.yaml   # Dry-run overrides (mode, strategies, permissive risk limits)
└── execution.live.yaml      # Live overrides (mode, strategies, production risk limits)

.env                         # Local secrets (git-ignored) — copy from .env.example
.env.example                 # Template with placeholder values — safe to commit
```

## Precedence Order (low → high)

| Layer | Source | Example |
|-------|--------|---------|
| 1. Schema defaults | Zod `.default()` in `schema.ts` | `marketRefreshMs: 60000` |
| 2. Base config | `execution.base.yaml` | Exchange definitions, ports, scheduler |
| 3. Mode-specific config | `execution.{dry-run,live}.yaml` | `mode`, `risk`, `strategies` |
| 4. Env overrides | `EXECUTION_POSTGRES_URL` | Postgres connection URL |
| 5. CLI flags | `--funding HH:MM:SS` | Funding time override for replay/testing |

The mode-specific file **replaces** top-level keys from the base file, not deep-merges them. Arrays (e.g. `exchanges`, `strategies`) are **replaced wholesale** — if the mode file specifies an `exchanges` list, it fully overrides the base list.

## Validation

```bash
# Validate dry-run config (auto-locates execution.base.yaml in the same directory)
npm run config:validate -- --config config/execution.dry-run.yaml

# Validate live config
npm run config:validate -- --config config/execution.live.yaml

# Validate against an explicit base
npm run config:validate -- --config config/execution.live.yaml --base config/execution.base.yaml
```

Exit 0 = valid. Exit 1 = one or more errors printed to stderr.

The validator runs two stages in sequence:
1. **Structural** (`schema.ts` Zod `.safeParse`) — collects all type/enum/required errors at once and reports them together.
2. **Semantic** (`parseEngineConfig`) — cross-field rules: live safety ceiling, LONG/SHORT co-run guard, funding-time override bounds (−1h to +24h).

## Secrets Matrix

Never put real secrets in `config/*.yaml` or commit them to git. The YAML files reference `credentialsEnvPrefix` — credentials are injected at runtime from matching env vars.

| Secret | Local dev | Production |
|--------|-----------|------------|
| `BINANCE_API_KEY` / `_API_SECRET` | `.env` | `ansible/group_vars/all.yml` → `/opt/arbinet/execution/secrets/execution.env` |
| `BYBIT_API_KEY` / `_API_SECRET` | `.env` | same |
| `OKX_API_KEY` / `_API_SECRET` / `_API_PASSPHRASE` | `.env` | same |
| `BITGET_API_KEY` / `_API_SECRET` / `_API_PASSPHRASE` | `.env` | same |
| `GATEIO_API_KEY` / `_API_SECRET` | `.env` | same |
| `KUCOIN_API_KEY` / `_API_SECRET` / `_API_PASSPHRASE` | `.env` | same |
| `EXECUTION_POSTGRES_URL` | `.env` | `execution.env` |
| `GIT_SHA` | auto-detected | auto-detected or set by deploy script |

`_API_PASSPHRASE` is only required for OKX, Bitget, and KuCoin.

## Key Parameters Reference

### `exchanges[]`

One entry per exchange. The `exchanges` array in the mode-specific file replaces the base list.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `exchange` | enum | — | `binance` \| `bybit` \| `okx` \| `bitget` \| `gateio` \| `kucoin` |
| `enabled` | bool | — | Whether this exchange participates in the engine |
| `credentialsEnvPrefix` | string | exchange uppercased | Env var prefix for API key injection |
| `restBaseUrl` | string | (exchange default) | Override REST base URL (useful for testnet) |
| `privateWsUrl` | string | (exchange default) | Override private WebSocket URL |
| `marketRefreshMs` | ms | `60000` | Interval between market metadata refreshes |
| `fundingPullMs` | ms | `15000` | Interval between funding rate polls |
| `rateLimits.criticalReservationFraction` | fraction | `0.1` | Fraction of rate budget reserved for critical paths (order submit, cancel) |
| `rateLimits.criticalWindowSeconds` | s | `60` | Window over which the reservation is enforced |
| `rateLimits.buckets[].endpointClass` | string | — | Endpoint class label (exchange-specific) |
| `rateLimits.buckets[].tokensPerSecond` | number | — | Token bucket refill rate |
| `rateLimits.buckets[].burst` | number | — | Token bucket burst capacity |

### `strategies[]`

Only `strategy_1` and `strategy_3a` are wired.

See [trading-logic.md](./trading-logic.md) for full per-strategy parameter semantics.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `id` | enum | — | `strategy_1` \| `strategy_3a` |
| `enabled` | bool | — | Whether this strategy fires |
| `negativeFundingThresholdPercent` | % | — | Minimum (most negative) funding rate to trigger entry |
| `entryOffsetSeconds` | s | — | Seconds before funding time to open the position |
| `stopLossPercent` | % | — | Distance from entry price to stop-loss trigger |
| `tpVariantAMultiplier` | × | — | TP = `\|fundingRate\|` × multiplier (`strategy_3a` only) |
| `deadlineSeconds` | s | — | Max position lifetime before forced exit |
| `amountUsd` | USD | — | Notional size per intent |
| `leverage` | × | — | Leverage applied at the exchange |

### `risk`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `globalMaxConcurrentIntents` | count | `10` | Engine-wide cap on simultaneous open intents |
| `globalMaxNotionalUsd` | USD | `1000` | Engine-wide notional cap; >$100k in live mode requires `acknowledgeUncapped: true` |
| `acknowledgeUncapped` | bool | `false` | Required acknowledgement when `globalMaxNotionalUsd` > $100k in live mode |
| `perStrategy.<id>.maxConcurrentIntents` | count | — | Per-strategy intent cap |
| `perStrategy.<id>.maxNotionalUsd` | USD | — | Per-strategy notional cap |

### `persistence`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `postgresUrl` | string | (from `EXECUTION_POSTGRES_URL`) | Postgres connection string |
| `writerQueueSize` | count | `1000` | Max in-flight DB writes before backpressure |
| `walPath` | path | `""` | Write-ahead log file path; empty = no WAL (prod: `/data/execution`) |
| `batchSize` | count | `100` | Rows per DB batch write |
| `flushIntervalMs` | ms | `250` | Max time between forced flushes |
| `walMaxBytes` | bytes | `52428800` | WAL rotation threshold (50 MiB) |

### `scheduler`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `wakeBeforeHourEndMs` | ms | `300000` | Engine wakes N ms before the hour boundary to prepare funding evaluations (default: 5 min → wakes at HH:55:00) |
| `fundingWindowMs` | ms | `600000` | Only schedule symbols whose `nextFundingTime` falls within this window |

### `observability`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `metricsPort` | port | `9464` | Prometheus `/metrics` scrape target |
| `healthPort` | port | `9466` | `/health` (liveness) and `/ready` (readiness) endpoints |
| `tracing.enabled` | bool | `false` | Enable OpenTelemetry tracing. Set to `true` in `execution.live.yaml`. |
| `tracing.serviceName` | string | `execution-engine` | Service name in traces |
| `tracing.endpoint` | string | — | OTLP collector endpoint (required when `enabled: true`). Live mode uses `http://localhost:4318/v1/traces` (Jaeger on the same host via `--network host`). |
| `tracing.sampler` | — | `parent` | `always_on` \| `parent` \| `{ ratio: 0–1 }` |

### `testing` (optional)

Only valid in dry-run mode. Using `testing` in a live-mode config with `acknowledgeLiveOverride: true` is possible but requires explicit opt-in and is strongly discouraged outside of controlled tests.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `testing.fundingTimeOverride` | object | — | Override the next funding time for replay/testing |
| `testing.fundingTimeOverride.utcTime` | `HH:MM:SS` | — | Use next occurrence of this UTC time |
| `testing.fundingTimeOverride.timestampMs` | number | — | Absolute epoch timestamp in ms |
| `testing.shadowFillDelayMs` | ms | `150` | Simulated fill latency in dry-run mode |

## How to Add a New Config Parameter

1. Add the field to the relevant interface in `src/execution/config/types.ts`.
2. Add it to the matching Zod schema in `src/execution/config/schema.ts` with a `.default()` where appropriate.
3. Add it to `execution.base.yaml` (if common across modes) or both mode-specific files (if it varies). Include an inline comment with units and allowed values.
4. Reference it via the typed `EngineConfig` object in engine code.
5. Run `npm run config:validate -- --config config/execution.dry-run.yaml` to confirm the schema passes.
6. Add a case to `schema.test.ts` if the parameter has a semantic constraint.

## Secret Rotation Procedure

**Exchange API key:**
1. Generate the new key pair on the exchange (keep the old key active).
2. Update the values in `ansible/group_vars/all.yml`.
3. Run `npm run deploy` — this re-templates `/opt/arbinet/execution/secrets/execution.env` on the server.
4. Verify the engine picks up the new key: check `engine.started` log event shows no credential errors.
5. Revoke the old key on the exchange.

**Postgres password:**
1. Update `postgres_password` in `ansible/group_vars/all.yml`.
2. Run `npm run deploy` to push the new `.env` to the server.
3. The engine will use `EXECUTION_POSTGRES_URL` from the new `execution.env` on next restart.

> **Note:** `ansible/group_vars/all.yml` contains plaintext credentials by design (post-vault refactor). Protect this file accordingly — do not push to a public remote.

## See Also

- [infrastructure.md](./infrastructure.md) — where secrets end up on the server, Ansible role responsibilities, prod service inventory
- [commands.md](./commands.md) — `config:validate`, `execution:dry-run`, `execution:live` invocations
- [runbook.md](./runbook.md) — pre-flight checklist, deploy, secret rotation steps in operational context
