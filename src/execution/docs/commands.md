# Execution Engine — Commands

## Engine lifecycle

### `npm run execution:live`

Start the execution engine in live mode. Submits real orders using `config/execution.live.yaml`.

```bash
npm run execution:live
```

Pass additional flags after `--`:

```bash
# Restrict to specific exchanges
npm run execution:live -- --exchange binance --exchange bybit

# Restrict to specific symbols
npm run execution:live -- --symbol BTCUSDT --symbol ETHUSDT

# Override health and metrics ports
npm run execution:live -- --health-port 9467 --metrics-port 9465

# Test a specific funding window (dry-run only — see --ack-live-funding-override for live)
npm run execution:dry-run -- --funding 08:00:00
```

| Flag | Type | Required | Default | Effect |
|---|---|---|---|---|
| `--config` | string | yes | `config/execution.live.yaml` (set by npm script) | Config file path |
| `--exchange` | string (repeatable) | no | all enabled exchanges | Restrict evaluation to these exchanges |
| `--symbol` | string (repeatable) | no | all symbols | Restrict evaluation to these symbols |
| `--funding` | string (`HH:MM:SS`) | no | — | Override next funding event time for testing |
| `--ack-live-funding-override` | boolean | no | — | Required when `--funding` is used in live mode |
| `--metrics-port` | number | no | config `observability.metricsPort` (default 9464) | Prometheus metrics port |
| `--health-port` | number | no | config `observability.healthPort` (default 9466) | Health/ready HTTP port |

**Prerequisites**: `db:postgres:up`, `execution:migrate` applied, exchange API credentials in `.env`.

Graceful shutdown on `SIGINT`/`SIGTERM` — flattens all open positions before exit.

---

### `npm run execution:dry-run`

Start the engine in dry-run mode using `config/execution.dry-run.yaml`. Uses shadow REST and WebSocket adapters; no real orders are placed. Fill events are simulated after `shadowFillDelayMs` (default 150 ms).

```bash
npm run execution:dry-run

# Pin a specific funding window for repeatable testing
npm run execution:dry-run -- --funding 16:00:00
```

Accepts the same flags as `execution:live`.

**Prerequisites**: `db:postgres:up`, `execution:migrate`.

---

## Config

### `npm run config:validate`

Validate a config file without starting the engine. Runs two-stage validation: structural (Zod schema, collects all field errors) then semantic (cross-field rules: duplicate exchanges, LONG/SHORT co-run guard, live notional ceiling).

```bash
npm run config:validate -- --config config/execution.dry-run.yaml
npm run config:validate -- --config config/execution.live.yaml
npm run config:validate -- --config config/execution.live.yaml --base config/execution.base.yaml
```

| Flag | Type | Required | Default | Effect |
|---|---|---|---|---|
| `--config` | string | yes | — | Path to YAML config to validate |
| `--base` | string | no | auto-detects `execution.base.yaml` in same directory | Explicit base config path |

Exit 0 on pass; exit 1 with all errors printed on failure.

---

## Sub-account provisioning

### `npm run provision`

Reuse or create a sub-account, ensure API keys, and reconcile it to the requested capital. See [provisioning.md](./provisioning.md) for the full operator guide.

```bash
npm run provision -- --strategy strategy_1 --exchange bybit --capital 200
```

| Flag | Required | Default | Effect |
|------|----------|---------|--------|
| `--strategy` | yes | — | Strategy ID |
| `--exchange` | yes | — | Exchange name |
| `--capital` | yes | — | Target USDT balance for the sub-account |
| `--label` | no | `{strategy}-{exchange}` | Sub-account display name on the exchange |
| `--registry` | no | `live-configs/registry.yaml` | Registry file path |

Resolution order is assigned entry, LRU idle pool entry, then new sub-account creation. Re-running the same command is intended to be a no-op except for capital reconciliation and verification.

**Prerequisites**: `MASTER_{EXCHANGE}_API_KEY` / `MASTER_{EXCHANGE}_API_SECRET` (and `_API_PASSPHRASE` where required) in `.env`.

---

### `npm run provision:release`

Drain capital back to master and return the sub-account to the idle pool. API keys are kept for reuse.

```bash
npm run provision:release -- --strategy strategy_1 --exchange bybit
```

| Flag | Required | Default | Effect |
|------|----------|---------|--------|
| `--strategy` | yes | — | Strategy ID |
| `--exchange` | yes | — | Exchange name |
| `--registry` | no | `live-configs/registry.yaml` | Registry file path |

---

### `npm run provision:list`

Print active and idle registry entries grouped by exchange.

### `npm run provision:sync`

Fetch exchange sub-account inventory and add unknown sub-accounts as idle registry entries without keys.

```bash
npm run provision:sync -- --exchange bybit
```

---

### `npm run registry:validate`

Validate `live-configs/registry.yaml` — checks uniqueness, IP allowlist, passphrase presence, strategy names, and sub-account limits.

```bash
npm run registry:validate
```

---

## Migrations

### `npm run execution:migrate`

Run pending Drizzle migrations against the configured Postgres database. Safe to run repeatedly — applies only unapplied migrations.

```bash
npm run execution:migrate
```

**Prerequisites**: `db:postgres:up`, `EXECUTION_POSTGRES_URL` in `.env`.

---

### `npm run execution:migrate:generate`

Generate a new Drizzle migration file from schema changes in `src/execution/persistence/drizzle/schema.ts`.

```bash
npm run execution:migrate:generate
```

Run after modifying the Drizzle schema. Commit the generated migration file before deploying — `execution:migrate` on the server applies it.

---

## Observability

### `npm run alerts:test`

Fire a test Slack alert to verify the webhook is wired correctly. Does not start the engine.

```bash
# Default: notify severity
npm run alerts:test

# Page severity (prefixes message with <!channel>)
npm run alerts:test -- --severity page

# Custom message
npm run alerts:test -- --severity notify --message "smoke test after deploy"
```

| Flag | Type | Required | Default | Effect |
|---|---|---|---|---|
| `--severity` | `notify` \| `page` | no | `notify` | `page` adds `<!channel>` mention |
| `--message` | string | no | `'smoke test from alerts:test'` | Alert body text |

**Prerequisites**: `SLACK_WEBHOOK_URL` in `.env`.

---

### `npm run dashboard:up`

Start Prometheus, Grafana, and Jaeger containers (defined in `docker/docker-compose.yml`). Postgres is started separately with `db:postgres:up`.

```bash
npm run dashboard:up
```

**Prerequisites**: Docker Desktop running, `.env` present.

---

### `npm run dashboard:open`

Open Grafana (`:3000`) and Jaeger (`:16686`) in the default browser.

```bash
npm run dashboard:open
```

**Prerequisites**: `dashboard:up` containers healthy.

---

### `npm run dashboard:down`

Stop and remove the Prometheus, Grafana, and Jaeger containers.

```bash
npm run dashboard:down
```

---

## Replay and emergency tools

### `npm run execution:replay`

Load an intent's lifecycle from Postgres and compute estimated P&L. Does not touch exchange APIs.

```bash
# Single intent, table output
npm run execution:replay -- --intent <intent-id> --format table

# All intents from a run
npm run execution:replay -- --run <run-id>

# Include funding-rate reevaluation diff
npm run execution:replay -- --intent <intent-id> --reevaluate
```

| Flag | Type | Required | Default | Effect |
|---|---|---|---|---|
| `--intent` | string | one of `--intent`/`--run` | — | Replay a single intent by ID |
| `--run` | string | one of `--intent`/`--run` | — | Replay all intents from a run |
| `--reevaluate` | boolean | no | `false` | Compare persisted funding snapshot against reevaluated rate; reports divergence |
| `--format` | `json` \| `table` | no | `json` | Output format |

Output fields: `intentId`, `exchange`, `symbol`, `strategy`, `side`, `status`, `entryFills`, `exitFills`, `fundingAttribAmount`, `estimatedPnlUsdt`.

**Prerequisites**: `EXECUTION_POSTGRES_URL` in `.env`.

---

### `tsx src/execution/cli/flatten.ts` (emergency flatten)

Cancel all open orders and market-close all open positions. Operates directly via REST adapters — the engine process does not need to be running.

```bash
# Flatten all configured exchanges
tsx src/execution/cli/flatten.ts --config config/execution.live.yaml

# Flatten a single exchange
tsx src/execution/cli/flatten.ts --config config/execution.live.yaml --exchange binance

# Simulate without placing orders
tsx src/execution/cli/flatten.ts --config config/execution.live.yaml --dry-run
```

| Flag | Type | Required | Default | Effect |
|---|---|---|---|---|
| `--config` | string | yes | — | Path to live config (must contain real credentials) |
| `--exchange` | string (repeatable) | no | all enabled | Restrict to specific exchange(s) |
| `--dry-run` | boolean | no | `false` | Log actions without submitting orders |

**Prerequisites**: live exchange credentials in `.env` for all targeted exchanges.

---

## Tests

### `npm run test:execution`

Run the execution engine unit and integration test suite with Vitest.

```bash
npm run test:execution
```

No database or network connection required — tests use in-memory mocks.

---

## Database (Postgres)

### `npm run db:postgres:up`

Start the Postgres container defined in `docker/docker-compose.yml`.

```bash
npm run db:postgres:up
```

---

### `npm run db:postgres:down`

Stop and remove the Postgres container.

```bash
npm run db:postgres:down
```

---

### `npm run db:postgres:shell`

Open a `psql` shell into the running Postgres container.

```bash
npm run db:postgres:shell
```

**Prerequisites**: `db:postgres:up`.

---

## Deployment

### `npm run setup`

Full server provisioning via Ansible. Runs `infra:inventory` first to regenerate `ansible/inventory/hosts.ini` from Terraform output, then runs the full `setup.yml` playbook (OS packages, Docker, Postgres, execution engine service, observability stack).

```bash
npm run setup
```

**Prerequisites**: `npm run infra:apply` completed; SSH key at `~/.ssh/nicolas`.

---

### `npm run deploy`

Fast redeploy: git pull, build, and restart the execution engine on the server. Runs `infra:inventory` first then the `deploy.yml` playbook.

```bash
npm run deploy
```

**Prerequisites**: changes pushed to origin; SSH key at `~/.ssh/nicolas`.

---

### `npm run deploy:migrate`

Run Drizzle migrations on the server via a one-shot `worker-migrate` systemd service. Waits for completion and checks exit status.

```bash
npm run deploy:migrate
```

Run after deploying a schema change (after `npm run deploy`). **Prerequisites**: `deploy` completed successfully.

---

## Remote ops

### `npm run remote:ssh`

Open an interactive SSH session to the Hetzner server.

```bash
npm run remote:ssh
```

---

### `npm run remote:status`

Show running Docker containers and systemd timer states on the server.

```bash
npm run remote:status
```

---

## Advanced scripts (direct `tsx` invocations)

These scripts are not registered in `package.json`. Invoke them directly with `tsx --env-file=.env`.

### Conformance tests — REST adapters

Place and immediately cancel a safe GTC limit order far from market to verify each exchange REST adapter end-to-end.

```bash
tsx --env-file=.env src/execution/scripts/conformance-rest-bybit.ts
tsx --env-file=.env src/execution/scripts/conformance-rest-bitget.ts
tsx --env-file=.env src/execution/scripts/conformance-rest-okx.ts
tsx --env-file=.env src/execution/scripts/conformance-rest-gateio.ts
tsx --env-file=.env src/execution/scripts/conformance-rest-kucoin.ts
```

Tests: `getServerTime`, `getBalance`, `getPositions`, `getOpenOrders`, `createOrder` (GTC limit far from market), `cancelOrder`, idempotent cancel. For Binance, use `live-rest-test.ts` (more comprehensive, same test cost ~$0.03).

**Prerequisites**: exchange API credentials in `.env`.

---

### Conformance tests — private WS adapters

Connect, authenticate, place and cancel a REST order, verify WS order and balance events received.

```bash
tsx --env-file=.env src/execution/scripts/conformance-ws-bybit.ts
tsx --env-file=.env src/execution/scripts/conformance-ws-bitget.ts
tsx --env-file=.env src/execution/scripts/conformance-ws-okx.ts
tsx --env-file=.env src/execution/scripts/conformance-ws-kucoin.ts
```

**Prerequisites**: exchange API credentials in `.env`.

---

### Live strategy drivers (single funding cycle)

Run the engine for one funding cycle on a manually chosen symbol. Prints a post-trade JSON summary. Uses real credentials and places real orders.

```bash
# Strategy 1 (LONG, timed exit)
tsx --env-file=.env src/execution/scripts/live-strategy-1.ts \
  --config config/execution.live.yaml \
  --symbol BTCUSDT

# Strategy 3a or 3b (SHORT, SL/TP)
tsx --env-file=.env src/execution/scripts/live-strategy-3.ts \
  --config config/execution.live.yaml \
  --symbol ETHUSDT
```

| Flag | Type | Required | Default | Effect |
|---|---|---|---|---|
| `--config` | string | yes | — | Path to execution config |
| `--symbol` | string | yes | — | Trading symbol (e.g., `BTCUSDT`) |
| `--timeout-minutes` | number | no | `20` | Kill the driver after this many minutes |
| `--funding-fee-grace-seconds` | number | no | `10` | Wait this many seconds after funding event before shutdown |

`live-strategy-3.ts` requires `strategy_3a` enabled in config.

**Prerequisites**: `BINANCE_API_KEY`, `BINANCE_API_SECRET` in `.env`.

---

### Live E2E tests

Full 9-phase engine test against Binance mainnet with real market orders. Estimated cost: ~$0.03–$0.05 in trading fees (single exchange) or ~$0.006 per exchange with XRP (multi-exchange).

```bash
# Single exchange (Binance, BTCUSDT, ~$100 notional)
tsx --env-file=.env src/execution/scripts/live-e2e-test.ts

# All configured exchanges (XRPUSDT, $8–30 notional per exchange)
tsx --env-file=.env src/execution/scripts/live-e2e-test-multi.ts
```

Test phases: startup → private WS connect → state reconcile → intent submit → entry fill → position verify → cancel intent → exit fill → position closed.

**Prerequisites**: `BINANCE_API_KEY`, `BINANCE_API_SECRET` (and per-exchange equivalents for `live-e2e-test-multi.ts`) in `.env`.

---

## Related docs

- **Configuration reference** (all YAML keys, defaults, secrets): [configuration.md](./configuration.md) *(Step 3)*
- **Infrastructure and deployment context**: [infrastructure.md](./infrastructure.md) *(Step 3)*
- **Full operational runbook**: [runbook.md](./runbook.md) *(Step 4)*
