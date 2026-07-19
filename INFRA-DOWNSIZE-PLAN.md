# Infra Downsize Plan — arbinet (Hetzner)

**Goal:** cut monthly cost ~85% while keeping ClickHouse (`arbinet` DB) and Postgres data
queryable. Stop all non-essential services. Downsize server `cpx62 → cpx32` and volume
`200 GB → 50 GB`.

**Status:** PLAN — not yet executed. Phase 1 (server-side, reversible) partially started then paused.

---

## Decisions (locked)

1. Disable + stop timers `worker-market-sync` + `worker-funding-rates`. No new data written.
2. Clean ClickHouse `system` DB logs (~6.27 GiB reclaim).
3. **Keep Postgres** (`/data/postgres`, ~135 MB) — valuable.
4. Option A: downsize, keep ClickHouse queryable. Stop everything except **clickhouse + postgres**.
5. Keep data on the volume, but shrink volume `200 GB → 50 GB` (copy-swap — Hetzner volumes can't shrink in place).
6. Server `cpx62` (16 vCPU/32 GB) → **`cpx32`** (~4 vCPU/8 GB/160 GB). 8 GB RAM → no swap/OOM worry.

---

## Current state (verified 2026-05-31)

| Item                 | Value                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Server               | `arbinet`, type `cpx62`, id `127349851`, dc `nbg1-dc3`, IP `203.0.113.10`                                                           |
| Specs                | 16 vCPU AMD EPYC-Genoa, 32 GB RAM, 600 GB boot disk (58 G used), load ~0.14                                                           |
| Volume               | `arbinet-data`, id `105446342`, 200 GB ext4, dev `/dev/disk/by-id/scsi-0HC_Volume_105446342`, mount `/data` (46 G used)               |
| ClickHouse `arbinet` | **38.15 GiB, ~3.0 B rows** ← the payload                                                                                              |
| ClickHouse `system`  | 6.27 GiB (logs — disposable)                                                                                                          |
| Postgres             | `/data/postgres` 135 MB (keep)                                                                                                        |
| Containers           | clickhouse(keep), postgres(keep), + prometheus, grafana, loki, promtail, jaeger, alertmanager, caddy (stop)                           |
| Timers               | `worker-market-sync.timer`, `worker-funding-rates.timer` (hourly — disable)                                                           |
| Compose              | `/opt/arbinet/docker-compose.prod.yml`; execution+workers already profile-gated; **observability has NO profile (starts by default)** |

**Tooling:** terraform v1.14.8 (local), ansible (local), rsync (local). State is **local** (`terraform/terraform.tfstate`), no remote backend.

---

## 🚫 Blocker — Hetzner API token required

`HCLOUD_TOKEN` unset; no `terraform.tfvars`; no `hcloud` CLI. Every Hetzner-side step
(create volume, recreate server, delete volume) needs `var.hcloud_token`.

**Action required from user (Phase 0):** create `terraform/terraform.tfvars`:

```hcl
hcloud_token   = "<HETZNER_API_TOKEN>"
ssh_public_key = "<contents of ~/.ssh/nicolas.pub>"   # ed25519 ...nicolasmazuryk@gmail.com
```

Shell env does not persist between tool calls, so the tfvars file (auto-loaded by terraform)
is the reliable mechanism. **Confirm `*.tfvars` is gitignored** before writing the token.

---

## Cost impact

|           | Now              | After          |
| --------- | ---------------- | -------------- |
| Server    | cpx62 ~€55–70/mo | cpx32 ~€7.5/mo |
| Volume    | 200 GB ~€10/mo   | 50 GB ~€2.5/mo |
| IPv4      | ~€0.50           | ~€0.50         |
| **Total** | **~€65–80/mo**   | **~€10.5/mo**  |

---

## Critical risks & safety gates

- **Server MUST be recreated** (can't shrink 600 GB boot disk to cpx32's 160 GB in place) → `-replace`. ⇒ **new IP**, new SSH host key.
- **Data safety:** keep old 200 GB volume as backstop until the new setup is fully verified. Also back up `/opt/arbinet/.env` locally.
- **Volume reformat risk:** ansible `base` role mounts `/data`. Before `setup`, VERIFY the filesystem task is non-destructive (skips mkfs when ext4 already present). If it formats unconditionally → DATA LOSS. Patch to `force=no` / creates-only-if-absent.
- **Password match risk:** ClickHouse/Postgres passwords are baked into the data on first init; the container ignores `*_PASSWORD` env on existing data. Ansible-regenerated `/opt/arbinet/.env` must contain the SAME passwords (verify they're fixed in ansible group_vars/vault, not random). Back up current `.env` as reference.
- **Observability docker volumes** (prometheus/grafana/loki/jaeger/caddy) live on the boot disk, not `/data` → lost on recreate. Acceptable (disposable).
- **Rollback:** if anything fails, recreate any server + reattach the **old 200 GB volume** (id `105446342`) → back to current state.

---

## Phase 0 — Prerequisites (user + checks)

- [ ] User adds `terraform/terraform.tfvars` (token + ssh key). Confirm gitignored.
- [ ] `cd terraform && terraform plan` runs clean (auth works, no unexpected drift).
- [ ] Confirm `cpx32` specs via `terraform plan` (invalid type errors here).
- [ ] Back up `/opt/arbinet/.env` → local `./backups/arbinet.env.bak`.
- [ ] (Optional, recommended) Local tar backup of `arbinet` + `postgres` as ultimate net.

## Phase 1 — Quiesce + cleanup + stop stack (SSH, reversible, NO token)

Run as one remote script (`ssh ... 'bash -s' < script`):

- [ ] `sudo systemctl disable --now worker-market-sync.timer worker-funding-rates.timer`
- [ ] Truncate all `system.*` MergeTree log tables (reclaim ~6.27 GiB):
      loop `SELECT name FROM system.tables WHERE database='system' AND engine LIKE '%MergeTree%'` → `TRUNCATE TABLE system.<name>`.
- [ ] `docker stop arbinet-prometheus arbinet-grafana arbinet-loki arbinet-promtail arbinet-jaeger arbinet-alertmanager arbinet-caddy`; `docker rm pensive_keller`.
- [ ] **Verify:** timers inactive; only clickhouse+postgres `Up`; `arbinet` still 38 GiB / ~3.0 B rows; `system` DB shrunk; `/data` usage down; free RAM.

## Phase 2 — Repo changes (durable, committed, NO token)

- [ ] `docker-compose.prod.yml` (repo source + ansible template): add `profiles: ["observability"]` to prometheus, grafana, loki, promtail, jaeger, alertmanager, caddy. Keep clickhouse + postgres unprofiled (default-start).
- [ ] `terraform/variables.tf`: `server_type` default `cpx62 → cpx32`; `volume_size` default `200 → 50` (applied only in Phase 4 swap).
- [ ] `ansible/roles/workers`: do NOT enable the two sync timers (gate behind a var, default off), so re-provision keeps them disabled.
- [ ] `ansible/roles/base`: confirm/patch volume task to never reformat an existing ext4 volume.
- [ ] `.gitignore`: ensure `terraform/*.tfvars` ignored.
- [ ] Update `.claude/CLAUDE.md` IP references after cutover (Phase 6).

## Phase 3 — Migrate data to new 50 GB volume (token)

- [ ] Add temp resources to `terraform/volume.tf`: `hcloud_volume.data_new` (name `arbinet-data-50`, size 50, ext4, nbg1) + `hcloud_volume_attachment.data_new` → current server.
- [ ] `terraform apply` → creates + attaches 50 GB volume.
- [ ] SSH: identify new dev, `mkdir /mnt/new50`, mount; `docker stop arbinet-clickhouse arbinet-postgres` (consistent copy).
- [ ] `sudo rsync -aHAX --info=progress2 /data/ /mnt/new50/`.
- [ ] **Verify copy:** `du -sb /data` vs `/mnt/new50` match; file counts match; spot checksum `clickhouse/store` + `postgres`. Unmount `/mnt/new50`.

## Phase 4 — Recreate server as cpx32 + swap volume (token, state surgery)

- [ ] `terraform state rm hcloud_volume_attachment.data hcloud_volume.data` (old 200 GB volume → unmanaged backstop, NOT deleted).
- [ ] `terraform state mv hcloud_volume.data_new hcloud_volume.data`; `... data_new attachment → data`.
- [ ] Edit `volume.tf`: remove temp `data_new` blocks; `hcloud_volume.data` now name `arbinet-data-50`, size 50; set `volume_size=50`.
- [ ] `terraform plan` → only diff should be server_type (cpx62→cpx32).
- [ ] `terraform apply -replace=hcloud_server.main` → destroys cpx62, creates **cpx32**, reattaches 50 GB volume + network + firewall.

## Phase 5 — Provision + start + verify

- [ ] `npm run infra:inventory` (writes new IP to ansible inventory).
- [ ] Clear stale known_hosts for new IP if needed.
- [ ] `npm run setup` (ansible: docker, **non-destructive** /data mount, build image, `docker compose up -d` → only clickhouse+postgres via profiles, timers stay disabled).
- [ ] **Verify:** `arbinet` rows ≈ 3.0 B and size ≈ 38 GiB; postgres tables present; app/CLI can auth (passwords match); `df -h /data` ~40 G/50 G; only 2 containers up; RAM healthy on 8 GB.

## Phase 6 — Post-cutover cleanup

- [ ] Update IP in `.claude/CLAUDE.md` (ssh example + sub-account note) and any docs.
- [ ] After ≥1 successful verification window: delete old 200 GB backstop volume `105446342`
      (`brew install hcloud` + `HCLOUD_TOKEN=... hcloud volume delete 105446342`, or Hetzner console).
- [ ] Commit repo changes (compose profiles, terraform vars, ansible, plan).
- [ ] Confirm new monthly cost ~€10.5 in Hetzner console.

---

## Rollback

At any point before deleting the old volume: recreate a server (any type) via terraform with
the old volume `105446342` reattached, run `setup` → original state restored. Old 200 GB volume
is the single source of truth until Phase 6 deletion.

## Open questions / to confirm during implementation

- Exact `cpx32` specs (confirm in `terraform plan` / Hetzner console).
- ansible group_vars: are CH/PG passwords fixed (vault) or generated? (must be fixed).
- ansible `base` volume mount: reformat behavior — verify before `setup`.
- Local data backup before destroy: do it (slow, 38 GB) or rely on old-volume backstop only?
