# Strategy Execution Engine — Documentation

The Strategy Execution Engine evaluates funding-rate arbitrage opportunities across six USDT-margined perpetual-swap exchanges (Binance, Bybit, OKX, Bitget, Gate.io, KuCoin Futures), submits and manages orders over REST and WebSocket, and persists every lifecycle event to Postgres. It runs as a single Node.js process on a Hetzner Cloud server alongside a full observability stack (Prometheus, Grafana, Loki, Jaeger, Alertmanager) and supports two strategies (`strategy_1`, `strategy_3a`) with a configurable dry-run mode for safe testing before live deployment.

## Doc set

| File                                     | What it covers                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](./architecture.md)     | Component inventory, roles, data flow narrative, startup sequence, Mermaid lifecycle diagram, external dependencies |
| [trading-logic.md](./trading-logic.md)   | Strategy rules (entry triggers, position direction, sizing, exits), risk controls, per-strategy parameter tables    |
| [commands.md](./commands.md)             | Every `npm run` and CLI invocation — purpose, flags, prerequisites, examples                                        |
| [configuration.md](./configuration.md)   | Config file layout, precedence order, secrets matrix, parameter reference, how to add a parameter                   |
| [infrastructure.md](./infrastructure.md) | Local vs prod environments, Terraform/Ansible/systemd deployment flow, service inventory, observability hooks       |
| [runbook.md](./runbook.md)               | Start locally, deploy, hotfix, rollback, kill-switch response, state recovery, on-call guide                        |

## Quick start

→ [runbook.md — Start locally](./runbook.md#start-locally)

## Related docs

- **Canonical strategy specs**: [`docs-strategy/funding_rate_strategies.md`](../../../docs-strategy/funding_rate_strategies.md) — original business-level strategy specifications and profit thesis
- **Pipeline-side ops** (market sync, funding sync, quote sync): [`RUNBOOK.md`](../../../RUNBOOK.md)
