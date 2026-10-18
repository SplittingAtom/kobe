# KOBE-422: kobe restore refuses a freshly installed site: startup seeds gallery agents, so the target is never empty

- **Status:** in progress (group G5, branch `group-5-gates`; not pushed)
- **Branch / worktree:** `group-5-gates` in `../Kobe-g5`
- **Depends on:** found by KOBE-233 (failure 1)

## Plan

Find every row a fresh site's start writes before setup, list them with a row condition, let the
restore's target check accept exactly those and delete them before the load. Flip
gate4-restore.sh's expected-fail; fix docs.

## Decisions

- **What the start writes** (found by running the start-up writers on a fresh database:
  gallery seed, isolation auditor, a forced retention pass, the PII sweep, health and setup GETs):
  `site_agents` (gallery), `site_agent_versions` (published by nobody), `audit_log` (system
  `agent.created` / `agent.published`, scope gallery), `site_settings`
  (`retention.pass_started_at`, `retention.last_pass_at`, `retention.cursor`,
  `audit.pii_sweep_seq`). The isolation auditor already writes nothing before setup. Other jobs
  (budgets, approvals, model sync, offboarding, connector refresh) act on teams or providers, which
  a fresh site has none of; `model_gateway_state` is migration-seeded already.
- **One registry in `@kobe/db`** (`packages/db/src/startup-seeds.ts`, `STARTUP_SEEDED_ROWS`: table
  → SQL row condition), read by the CLI's prelude and by the server test that keeps it complete
  (`services/server/src/startup-seeds.db.test.ts` fails when a start-up writer writes a row no
  condition covers). Migration seeds stay in `packages/cli/src/seeded.ts`.
- **Check, then replace:** the prelude refuses a target with any row where the condition is not
  true (`(cond) IS NOT TRUE`), then deletes the whole table (every row is a seed by then), after
  all checks, triggers off and FKs deferred; the backup's rows load into empty tables, so the
  gallery key never meets a duplicate.
- **The started site's audit rows are dropped**, only system gallery-seed events. The restored
  chain is the backup's and `platform.restore.completed` continues it; keeping the target's rows
  would fork the chain. Anything a person did (or `platform.isolation.changed`) still refuses.
- **Review fixes (2026-10-18):** SIEM forwarding's `audit.forward.<destination>` keys are startup
  seeds too (the forwarder writes them on its first sweep, before setup). The guard test now runs
  exactly what a server replica starts: the background jobs moved from `index.ts` into
  `services/server/src/startup/jobs.ts` (`seedAtStart`, `serverJobs`, `startServerJobs`), and the
  test runs one pass of each with forwarding, the Bifrost sync (fake admin) and the header
  re-seal configured. Jobs that need the sandbox provider stay in `index.ts` (team reconcile,
  hibernation, pod reconciler, workspace collector, Orbit evals): they act on teams' sandboxes.
  `platform.restore.completed` records the replaced chain (`replacedAuditHeadSeq`, `…Hash`,
  `replacedAuditRows`), so anchors the fresh site logged are explained; a gallery agent archived
  by a person is no seed.
- The gate4-restore fallback (an empty, chart-migrated database) stays but runs only after the
  check fails, so the later checks still run.

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/cli/src/restore-target.db.test.ts` (prelude on a started site: seeds accepted and
  deleted, rolled back after; no pg tools); `backup-restore.db.test.ts` "restores into a site whose
  server started" (both sites have gallery agent `kobe`; restored rows equal the source's, audit
  actions source + restore event; CI); `services/server/src/startup-seeds.db.test.ts` (start twice:
  only those four tables change, every row covered).
- ac-2: `restore-target.db.test.ts` refuses a user, a personal agent, a non-seed audit event and
  a real setting; `backup-restore.db.test.ts` "still refuses a started site that holds real data".
- ac-3: `e2e/gate4-restore.sh` check is `contains` now (CI shard `restore` pending);
  docs/backup-restore.md, docs/install.md ("Backup and restore": recovery steps; First run says to
  skip setup on a site to be restored), docs/gates/gate-4.md.
- Local: `@kobe/cli` unit 89/89 and test:db 34/34 (round trips with libpq 17 from
  `/opt/homebrew/opt/libpq/bin` as `KOBE_PG_BIN_DIR`), typecheck, lint; `@kobe/db` unit;
  server typecheck, startup-seeds db test.
