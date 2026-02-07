# Infrastructure Runbook

## Scope
This runbook covers how to deploy, migrate, operate, and remove environments for this project.

## Prerequisites
- AWS CLI authenticated to the target account.
- Stage env files present with all required variables:
  - `.env.dev` for `dev`
  - `.env.prod` for `prod`
- `.env` is only for local runtime/local DB scripts.
- Dependencies installed: `npm install`.

## Environments
- `dev`: integration/testing environment.
- `prod`: production environment.

Use npm deploy scripts for infra operations so the correct stage file is auto-loaded.
Use `--stage <stage>` (or `SST_STAGE=<stage>`) to target an environment.

## Script Matrix
| Script | Run When |
|---|---|
| `npm run deploy:dev` | Deploying or updating `dev` infra/app. |
| `npm run deploy:prod` | Deploying or updating `prod`. |
| `npm run deploy:migrate:dev` | DB schema setup/changes on `dev`. |
| `npm run deploy:migrate:prod` | DB schema setup/changes on `prod`. |
| `npm run deploy:remove:dev` | Full cleanup for `dev` (stage + project ECR). SST asset/state buckets are preserved. |
| `npm run deploy:remove:prod` | Full cleanup for `prod` (stage + project ECR). SST asset/state buckets are preserved. |
| `npx sst remove --stage <stage>` | Remove only one stage (no ECR cleanup; buckets are never deleted by these scripts). |
| `npm run db:up` | Local ClickHouse needed for local work/tests. |
| `npm run db:down` | Stop local DB and clean local compose resources. |
| `npm run db:stop` | Stop local DB (containers kept). |
| `npm run db:logs` | Tail ClickHouse logs (local). |
| `npm run db:reset` | Re-initialize local DB from scratch. |
| `npm run db:verify` | Verify DB connectivity and config (uses `.env`). |
| `npm run db:shell` | Open ClickHouse client in local container. |
| `npm run sync:markets` | Run market sync once (local; uses `.env`). |
| `npm run sync:funding-rates` | Run funding-rates sync once (local; uses `.env`). |

## Initial Deployment (First Time)
1. Configure `.env.dev` and `.env.prod` from `.env.example`.
2. Deploy infra:
   - `npm run deploy:dev` (recommended first)
   - then `npm run deploy:prod` (when ready)
3. Run migrations after each environment’s first deploy:
   - `npm run deploy:migrate:dev`
   - `npm run deploy:migrate:prod`
4. Validate:
   - Check SST outputs/logs.
   - Verify ClickHouse health and scheduler/alarm status in AWS.

## Continuous Deployments
1. Code or infra changes:
   - `dev` first: `npm run deploy:dev`
   - `prod` after validation: `npm run deploy:prod`
2. Run environment-specific migrate script only if schema/migration files changed.
3. Smoke check key workloads after deploy (market sync, funding sync, alarms/logs).
4. Workers run only by cron schedule unless you manually run a task.

## Removing Environments
### Remove only one stage
Use:
```bash
npx sst remove --stage dev
```
or
```bash
npx sst remove --stage prod
```

### Full cleanup (stage teardown + ECR; SST buckets preserved)
Use:
```bash
npm run deploy:remove:dev
```
or
```bash
npm run deploy:remove:prod
```
Each does:
- `sst remove --stage <stage>`
- deletes project-scoped ECR repositories (prefix `SST_APP`, default `arbinet`, or `ECR_REPOSITORIES` override)

SST asset and state S3 buckets are **not** deleted so they can be reused across removals and redeployments.

## SST bootstrap reset (state/asset buckets deleted)

If the SST state or asset S3 buckets were accidentally deleted, the CLI will fail with "The state bucket is missing". Reset bootstrap so SST recreates them:

1. **Delete the bootstrap SSM parameter** in each region you use (e.g. from repo root):
   ```bash
   # Use the same region as in your .env.dev / .env.prod (e.g. AWS_REGION)
   source .env.dev 2>/dev/null || true
   aws ssm delete-parameter --name "/sst/bootstrap" --region "${AWS_REGION:-eu-central-1}"
   ```
   If you get `ParameterNotFound`, the parameter is already gone—proceed to step 2. If you deploy to multiple regions, run the same command with each region.

2. **Redeploy**; SST will recreate the state and asset buckets on first run:
   ```bash
   npm run deploy:dev
   ```
   (Repeat for `deploy:prod` if you use that region.)

Note: This starts with a clean bootstrap; existing stage state in the old buckets is gone. You are effectively doing a fresh deploy for all stages in that region.

## Safety Notes
- `deploy:remove:dev` and `deploy:remove:prod` remove the stage and project ECR repos; they do **not** delete SST asset/state buckets.
- For routine releases, use `deploy:dev`/`deploy:prod` and avoid the remove scripts.
- Prefer `dev` deployment first; promote to `prod` only after validation.
