# Sub-Account Provisioning

Provisioning uses a reusable sub-account pool. `npm run provision` first reuses the sub-account already assigned to a `(strategy, exchange)`, then picks the least-recently-used idle sub-account for that exchange, and only creates a new sub-account if the pool is empty.

## Commands

| Goal                                         | Command                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| Provision or reconcile live-ready capital    | `npm run provision -- --strategy <id> --exchange <name> --capital <usdt>` |
| List active and idle pool entries            | `npm run provision:list`                                                  |
| Release a strategy sub-account back to idle  | `npm run provision:release -- --strategy <id> --exchange <name>`          |
| Sync exchange sub-account list into registry | `npm run provision:sync -- --exchange <name>`                             |
| Validate registry                            | `npm run registry:validate`                                               |

## Registry States

| Status         | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `active`       | Assigned to a strategy and ready for live trading                           |
| `idle`         | In the exchange pool with zero allocated capital and no strategy assignment |
| `provisioning` | Temporary in-flight state                                                   |
| `failed`       | Last provisioning attempt failed; see `notes`                               |

Idle entries have `assigned_strategy: null` and `allocated_capital_usdt: 0`. Active entries require `assigned_strategy`, `api_key`, and `api_secret`; OKX and KuCoin also require `api_passphrase`.

## Provision

```bash
npm run provision -- --strategy strategy_3a --exchange bybit --capital 200
```

The command is idempotent. It ensures API keys exist, updates the registry label to `<strategy>-<exchange>`, renames the exchange-side label where the exchange supports it, reconciles USDT capital to the target, and prints a PASS/FAIL verification table. KuCoin balance verification is skipped because the master key cannot query the futures sub-account balance; provisioning uses the previous registry allocation as the assumed balance.

## Release

```bash
npm run provision:release -- --strategy strategy_3a --exchange bybit
```

Release drains USDT back to master with `reconcileCapital(..., 0)`, clears the strategy assignment, sets `status: idle`, and keeps API keys for reuse. It does not delete or freeze sub-accounts.

## Exchange Caveats

Binance, Bybit, Bitget, Gate.io, KuCoin, MEXC, and OKX are configured as `full_api`. Binance requires broker/master-tier permissions. KuCoin and MEXC do not support API rename; the registry label is updated and provisioning prints a warning.
