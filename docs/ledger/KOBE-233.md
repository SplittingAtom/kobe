# KOBE-233: G4b: backup → fresh cluster → restore round-trip and timed clean install

- **Status:** in progress (group G5, branch `group-5-gates`; not pushed)
- **Branch / worktree:** `group-5-gates` in `../Kobe-g5`
- **Depends on:** KOBE-232 (same branch: `e2e/gate4.sh` reads `restore.log` for U16)

## Plan

`e2e/gate4-restore.sh` (client steps `e2e/gate4/restore.mjs` after the Gate 1–3 helpers; bucket
copy `e2e/lib/s3-mirror.mjs`): a clean source install timed to the first assistant token, seeded,
writers stopped, `kobe backup` (the CLI on the runner through port-forwards), the site deleted, a
fresh one installed with the saved Secrets, `kobe restore`, then the integrity checks. CI: shard
`restore` in `.github/workflows/e2e.yml`; `restore.log` feeds the `stories` job (U16). Docs:
docs/gates/gate-4.md ("Backup → fresh site → restore", "Clean install timing"), docs/install.md
("First run: to the first chat").

## Decisions

- **Fresh cluster on k3d, fresh namespace on a real cluster** (`KOBE_GATE4_RESTORE_TARGET`). k3d
  deletes the whole cluster and creates a new one (`scripts/dev-cluster.sh`, the image archives kept
  for a second import). The k3d S3 fixture lives in the cluster, so the objects are copied out and
  back with the S3 API (keys, sizes and ETags checked): the documented "bucket that holds a copy".
- **The source is always a throwaway install the script makes** (own team `gate4-r`), in both
  modes; it is also the timed clean install (chart path, from `helm install` to the first
  `text.delta`, through setup token, provider, catalog, team, team default). The script does not
  use `e2e/run.sh`, so its checks don't inflate the timing.
- **Writers stopped before counting and the backup**, so team-table counts compare exactly with
  the source and with the signed manifest (the CLI's snapshot would be consistent anyway).
- **Grant decryption:** an API-key connector row inserted as Gate 2 does; the grant goes through
  `PUT /v1/connector-grants/:id`; opened in a server pod with the install's envelope (and refused
  with a random key), before and after.
- **Object references:** every `BLOB_REF_COLUMNS` key per team, plus `team_skill_versions.storage_key`
  (not in that list, see failure 2), checked against the bucket in a server pod.
- **The documented restore order is tried first** (XFAIL, failure 1); then an empty database
  migrated by the chart's own Job (`helm template --show-only templates/migrate-job.yaml`), so the
  remaining checks run against a real restore.
- **`namespace` mode refuses while another Kobe server runs** in the cluster (failure 3).
- **`e2e/gate4.sh` runs the restore last on k3d** (it deletes the cluster); on a real cluster it is
  a run of its own whose log is passed as `restore.log`.
- No new tools or images in the product; CI installs PostgreSQL 17 client tools from PGDG (as
  `ci.yml` does already) and builds `@kobe/cli`. Shellcheck 0.10.0 was used locally only.

## Product failures found

1. **`kobe restore` refuses every freshly installed site** (read in the code, CI to confirm): the
   server's start seeds the gallery agents (`services/server/src/gallery/seed.ts`: `site_agents`
   rows and their audit events), and `restorePrelude` refuses any loaded table with rows outside
   `SEEDED_TABLES` (`packages/cli/src/seeded.ts`). docs/backup-restore.md orders install → stop
   writers → restore, and the chart's schema forbids installing with 0 server replicas, so the
   documented procedure cannot succeed. Check: `kobe restore accepts the freshly installed site
once its writers are stopped`, XFAIL in `e2e/gate4-restore.sh` (CI stays green; the run goes on
   with an empty, chart-migrated database). **Fixed** by KOBE-422 on this branch: the restore
   replaces startup-seeded rows (docs/ledger/KOBE-422.md); the check is an ordinary one again.
2. **Skill bundle keys are not blob refs:** `team_skill_versions.storage_key` and
   `site_skill_versions.storage_key` hold object keys but are not in `BLOB_REF_COLUMNS`
   (`packages/db/src/blob-refs.ts`), so `kobe backup`'s "every referenced key is in the listing"
   check skips skill bundles. The restore's listing comparison still covers objects that existed.
   Not a check failure (this harness adds the team column itself).
3. **Two Kobe sites can't share a cluster:** every server converges every labelled team namespace
   (`team-reconcile.ts`) with its own release namespace in the NetworkPolicies and RoleBindings,
   so a second release rewrites the first's sandbox policies. Blocks the "fresh namespace on the
   real cluster" round-trip unless `kobe-gate1` is scaled to 0 for the run. Maybe by design (one
   site per cluster): for the coordinator to judge; if so, docs/install.md should say it.

## Open questions (for Chris or the coordinator)

- The `restore` shard's time on hosted runners is unmeasured: estimated 18–22 min (two clusters,
  two installs, two sandbox cold starts). If it runs over 20 min, split the timing install off.

- ac-2 (real cluster): needs the go-ahead, `kobe-gate1`'s server scaled to 0 for ~15 min, the deps
  Postgres NetworkPolicy admitting `kobe-restore` and `kobe-restore-src`, and a values file for the
  throwaway sites. Command in docs/gates/gate-4.md.
- ac-3's manual timing on the real cluster (by hand, following docs/install.md) is still to do.

## Evidence (acceptance criteria → test or command output)

- ac-1 (k3d in CI with the integrity assertions): shard `restore`; pending the group CI run.
- ac-2: command documented, not run (binding rule: nothing against the real cluster).
- ac-3: CI measures `helm install` → first token and the cluster creation (`==> install:` lines);
  table in docs/gates/gate-4.md pending the CI run; doc fix: docs/install.md "First run".
- Local: `bash -n`, shellcheck 0.10.0 (`-S warning`) clean for `e2e/gate4-restore.sh` and
  `e2e/gate4.sh`; actionlint clean; `node --check` on the composed client and the mirror; the
  team-count SQL run against a migrated test database (60 team tables); the U16 verdict on
  synthetic logs (restore sections ok, then a FAIL).
