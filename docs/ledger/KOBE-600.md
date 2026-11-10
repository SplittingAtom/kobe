# KOBE-600: Upgrade Bifrost v2.2.5 -> v2.5.1

Branch `kobe-600-bifrost-251` (worktree `Kobe-wt600`), from group branch `pipeline-b` (166b3a1c,
with KOBE-601). KOBE-414's research (`docs/design/bifrost-request-rewrite.md`) is the go decision.

## Done

- Pin `docker.io/maximhq/bifrost:v2.5.1@sha256:5ec9873acaf1687556b6e4dd854b92b539d9debf87a5a683b66338648b84d3c8`
  (multi-arch OCI index) in `images/bifrost/Dockerfile`, `charts/kobe/values.yaml`,
  `charts/kobe/templates/_models.tpl` and `charts/kobe/tests/models.test.ts`. `values.schema.json`
  has no Bifrost default. `tools/license-check` tests keep `v2.2.5` as fixture strings (not pins).
- Digest resolved from Docker Hub's registry API (`HEAD /v2/maximhq/bifrost/manifests/v2.5.1`
  with an anonymous pull token and `Accept: application/vnd.oci.image.index.v1+json`,
  `docker-content-digest` header); the same call for `v2.2.5` returns the old pinned digest
  (`sha256:65854fd1…f115`), and it matches KOBE-414's `sha256:5ec9873a…d3c8`. `docker pull` of the
  digest on the remote Docker host succeeded (linux/amd64).
- Licence: `transports/v2.5.1` still has a single `LICENSE` (Apache-2.0) at its root (GitHub tree
  API, no other licence/notice files); `inventory.yaml` row, `docs/licensing.md`,
  `THIRD_PARTY_LICENSES.md` (`pnpm licenses:update`) updated.
- Release notes v2.2.6, v2.3.0 (changelogs in the tag; no GitHub release), v2.3.1, v2.3.2, v2.4.0,
  v2.5.0, v2.5.1 checked against what Kobe uses (`kobe.bifrostConfig`, admin API, env). Nothing
  breaks it; no chart change needed:
  - v2.2.6 setup-token lock on `/api` applies only while dashboard auth is off; Kobe's
    `governance.auth_config.is_enabled: true` with an admin keeps it off. `enforce_auth_on_inference`
    default change: Kobe sets it explicitly (true).
  - v2.3.0 "auth config changes need proof of control" applies to re-enabling auth or rotating
    admin credentials **while auth is off**; Kobe's auth stays on (see open question below).
  - v2.3.0 `base_url` shape check (no userinfo/query/fragment): Kobe's provider URLs are plain.
  - v2.3.0 store migration `move_config_json_vk_limits_to_model_configs` (see ac-2).
  - v2.5.0 `user_email` / `client_ip` log columns: unused while `logs_store.enabled: false` and
    `client.enable_logging: false` (kept); `capture_client_ip` stays unset.
- New opt-in test `services/server/src/models/bifrost-upgrade.int.test.ts`
  (`KOBE_TEST_BIFROST_BIN` + `KOBE_TEST_BIFROST_BIN_PREVIOUS`): the old binary syncs, the new one
  migrates the same `config.db`; the sync must see 0 changes, keys keep id and value, the rate limit
  reads back, is enforced, and a changed rate still updates and converges. Reusable on later bumps.
- `docs/install.md` upgrade note (back up the PVC first; one-way store migration; rollback = backup
  - v2.2.5 image).

## Evidence

- **ac-1:** chart tests `pnpm --filter ./charts/kobe test` 19 files / 231 passed (models.test.ts
  asserts Dockerfile = values = `_models.tpl`); chart lint (helm lint --strict) ok;
  `pnpm license:check` exit 0; `scripts/check-public-hygiene.sh` ok.
- **ac-2:** binaries copied from the images (`/app/main` is static; `docker create` + `docker cp`
  on the remote Docker host, run on the workstation):
  - `bifrost.int.test.ts` with `KOBE_TEST_BIFROST_BIN=<v2.5.1>`: 3 passed (five provider kinds
    through a member's VK, KOBE-42 rate limit 429 then raise, KOBE-265 customer convergence; so
    v2.5.1 still keeps a team's customer on update and `fake-bifrost.ts` stays accurate).
  - `bifrost-upgrade.int.test.ts` v2.2.5 -> v2.5.1 on one store: 1 passed. Inspected the migrated
    `config.db`: `move_config_json_vk_limits_to_model_configs` ran, `governance_virtual_keys.rate_limit_id`
    is NULL and each key has a `governance_model_configs` row (`model_name *`, scope `virtual_key`)
    holding the rate limit; `GET /api/governance/virtual-keys` still reports `rate_limit`
    (`request_max_limit`, `request_reset_duration: 1m`), which is what `bifrost-admin.ts` reads.
  - Also: server `src/models` unit tests 54 passed (4 skipped = the opt-in real-Bifrost tests),
    server typecheck, eslint and prettier on touched files; model-gateway tests 17 files / 217
    passed.
- Docker host: the pulled v2.5.1 image and the temporary containers removed afterwards; the v2.2.5
  image was already there (left in place).

## Gate1 checks for the coordinator (ac-3)

Bifrost pulls from docker.io (not a `local-*` import); check the nodes can pull the new digest.

1. **Back up the store first and keep it** (never delete without asking Chris):
   `kubectl -n kobe-gate1 scale deploy/kobe-bifrost --replicas=0`, then a helper pod mounting PVC
   `kobe-bifrost` copies `/data/config.db` out (`kubectl cp`), plus a copy on the node or NAS;
   record size + sha256 in this ledger. (Or Longhorn snapshot/backup of the volume, in addition.)
2. Upgrade with `helm get values … -o yaml > v.yaml` and `-f v.yaml --reset-values` (never
   `--reuse-values`). Bifrost restarts with `Recreate`.
3. Bifrost log at start: migrations finish without error, including
   `move_config_json_vk_limits_to_model_configs` ("moved N budget(s) and M rate limit(s)"); pod
   ready, no restarts.
4. Server log: the next model sync (and team reconcile) reports no `bifrost_unauthorized` /
   `bifrost_rejected` errors and, on the pass after, 0 changes (virtual keys not recreated: compare
   the VK ids from `GET /api/governance/virtual-keys` before and after, as the admin).
5. Model check: every provider on gate1 (Ollama Cloud, plus any other configured provider, and the
   server's own calls such as auto-titles) answers through a member's conversation at each thinking
   level `off`, `low`, `medium`, `high` for one model per thinking control in use; streaming works;
   usage is metered (token counts on the turn).
6. Rate limit: a member's VK still carries the site/team per-minute rate (`rate_limit` on the key
   in the admin API).
7. Logs record no caller email or client IP: `kubectl logs deploy/kobe-bifrost` has no member
   email and no client/pod IP of a caller; the rendered config still has
   `logs_store.enabled: false` and `client.enable_logging: false` (ConfigMap `kobe-bifrost`),
   and no `capture_client_ip`.
8. Rollback, only if needed: scale Bifrost to 0, restore the backed-up `config.db` to the PVC,
   deploy the previous chart (v2.2.5 digest); the server's sync converges.

## Dependabot #456 close-out (coordinator, on GitHub)

Suggested comment, then close: "Superseded by KOBE-600: Bifrost is now pinned to v2.5.1 by digest
(images/bifrost/Dockerfile, chart values and `_models.tpl` together, checked by
charts/kobe/tests/models.test.ts). v2.4.0 was skipped on KOBE-414's research
(docs/design/bifrost-request-rewrite.md)."

## Open questions

- (Resolved) v2.3.0's proof-of-control rule for admin credential changes applies only while auth
  is off. Checked with the v2.5.1 binary: restarting on the same store with a new
  `BIFROST_ADMIN_PASSWORD` makes the new password work (200) and the old one fail (401), so a
  rotation of `bifrost-admin-password` still takes effect on restart.
- v2.5.1 was published 2026-11-10 (same day as this bump); KOBE-414 measured it the same day.
