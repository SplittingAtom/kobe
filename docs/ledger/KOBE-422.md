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
- The gate4-restore fallback (an empty, chart-migrated database) stays but runs only after the
  check fails, so the later checks still run.

## Open questions (for Chris or the coordinator)

- None. The full backup → restore round-trip tests need pg_dump/psql 17 (none on this Mac): they
  run in CI's `db` job.

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
- Local: `@kobe/cli` unit 88/88, typecheck, lint; `@kobe/db` unit 533/533; server typecheck;
  db suites restore-target 5/5, startup-seeds 1/1.
