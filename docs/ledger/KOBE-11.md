# KOBE-11: Backup and restore CLI

- **Status:** in progress
- **Branch / worktree:** `kobe-11-backup-restore` in `../Kobe-wt11`
- **Depends on:** KOBE-8 (db layer, merged)

## Acceptance criteria (derived from spec D31, U16, Gate 4; Hadron unreachable)

1. `kobe backup` writes a self-describing backup: `manifest.json`, a `pg_dump` data dump and an S3
   object manifest, taken from one consistent Postgres snapshot. Every table in `public` is backed
   up unless it is on the documented exclusion list, so tables added later are covered automatically.
2. Backup never silently loses team rows: it refuses a role that is subject to RLS and records the
   row count of every table in the dump's snapshot.
3. `kobe restore` into a freshly installed Kobe (migrated, empty) round-trips the data: every backed
   up table is row-for-row equal, RLS stays forced, app-role grants and team isolation hold.
4. Restore respects the role split and the migration journal: it runs as the owner, never touches
   schema, grants or `drizzle.*`; it refuses a target whose applied migrations differ from the
   backup's, a target that already has data, and a role that does not own the tables.
5. Restore is atomic: a failure (bad dump, row-count mismatch, constraint error) leaves the target
   unchanged, with RLS still forced.
6. S3 (external only): backup records every object (key, size, ETag); restore verifies the target
   bucket holds them and refuses when objects are missing unless explicitly allowed. Sandbox
   volumes are excluded (spec D31).
7. No plaintext secrets in backups: bearer/one-time tokens and signing keys are not backed up; the
   remaining secret columns are hashes or ciphertext under the auth secret; the manifest holds no
   credentials; files are written 0600 in a 0700 directory. The Kubernetes Secrets a restore needs
   are documented, not copied.
8. Integrity: checksums in the manifest are verified before anything is restored.
9. Docs: `docs/backup-restore.md` (requirements, roles, fresh-cluster procedure).

## Plan

New workspace `packages/cli` (`@kobe/cli`, bin `kobe`): `backup` and `restore`. Schema comes from
Kobe's migrations; the backup is data-only (`pg_dump -Fc --data-only --schema=public`) plus an S3
object listing and a manifest; restore streams `pg_restore --data-only` into one `psql`
transaction as the owner.

## Decisions

- **Placement:** `packages/cli` (operator CLI, depends on `@kobe/db` for `quoteIdent`,
  `MIGRATION_LOCK_KEY`, test support). `@kobe/db` now exports `MIGRATION_LOCK_KEY` (one-line change).
- **Data-only dump, schema from migrations.** Restore targets a freshly installed Kobe of the same
  migrations (journal compared hash-for-hash, in Node and again inside the transaction). Objects
  stay owned by the owner role, grants/RLS/journal are exactly the release's; role names may differ
  between source and target. Cross-version restore = restore on the old version, then
  `helm upgrade`.
- **Roles.** Backup needs `BYPASSRLS` + `pg_read_all_data` (or superuser): FORCE RLS binds the
  owner, so the owner would see no team rows (`pg_dump` errors; `--enable-row-security` would
  silently drop rows). The backup refuses RLS-bound roles. Restore runs as the **owner**
  (`KOBE_DB_MIGRATE_URL`): inside one transaction it lifts FORCE RLS (owner only; app role stays
  bound) and disables user triggers, loads, verifies row counts, re-forces, commits. No superuser
  needed for restore. The backup role is created by the operator (SQL in docs); the chart does not
  create it (keeps shared chart files untouched) — see open questions.
- **Secrets.** Excluded tables: `sessions` (bearer tokens), `verifications` (reset/verify
  tokens), `jwks` (signing keys; the server regenerates on first use, and the target's own key
  survives the restore), `rate_limits`. TOTP secrets/backup codes stay as ciphertext under the auth
  secret; passwords are scrypt hashes. Kubernetes Secrets are not backed up; docs say to keep them
  in a secret store and how to reinstall with the same auth secret. Backup files 0600 in a 0700
  dir; manifest holds no credentials (S3 endpoint with userinfo is rejected).
- **S3:** external only; the backup records a manifest (key, size, ETag), the restore verifies the
  target bucket (missing/resized → refuse unless `--allow-missing-objects`; ETag differences and
  extra objects only reported). No object copying (spec says "S3 manifest").
- **Consistency:** counts, journal and dump from one exported snapshot; backup holds the migration
  advisory lock shared, restore exclusive; both fail fast if a migration holds it.
- **New tables automatic:** every ordinary table in `public` is included unless on the exclusion
  list (`packages/cli/src/excluded.ts`, test pins it to real install-wide tables).
- **CI:** `db` job installs `postgresql-client-17` from PGDG (runner client is older than the
  server; pg_dump refuses newer servers) and puts it on PATH (turbo strict env passes PATH).

## Open questions (for Chris or the coordinator)

- Should the chart create the `kobe_backup` role in CNPG mode (managed role + generated Secret)?
  Left to docs to avoid touching `postgres-cnpg.yaml`/values/schema in this PR.
- Shipping the CLI: today `node packages/cli/dist/cli.js` from a checkout. A `kobe` image (Node +
  PG 17 client) for in-cluster backup Jobs/CronJobs is a natural follow-up.
- Gate 4 "backup → fresh cluster → restore" on k3d/k3s is not automated here (Postgres-level round
  trip is); add it to the e2e suite with Gate 4.

## Evidence (acceptance criteria → test or command output)

`packages/cli/src/backup-restore.db.test.ts` (real Postgres 17, pg_dump/pg_restore/psql 18.6
locally; 17 in CI), unit tests in `packages/cli/src/*.test.ts`.

1. Self-describing, consistent, new tables automatic → "backs up every table from one snapshot…"
   (a `widgets` table unknown to the CLI is backed up and restored).
2. Refuses RLS-bound role → "refuses a role bound by row-level security"; counts in manifest.
3. Round trip → "restores into a fresh install…": every table row-equal, FORCE RLS set unchanged,
   trigger back to `O`, sequence carried, app role sees 0 rows without a team and 2 with team T1.
4. Role split / journal → "refuses a target whose applied migrations differ", "refuses the app
   role", second restore "already has data".
5. Atomic → "rolls everything back when a check fails inside the transaction" (all tables empty,
   FORCE and trigger intact).
6. S3 → "refuses when S3 objects are missing, unless explicitly allowed"; `s3.test.ts` pagination.
7. Secrets → dump text contains no session/reset token or JWKS private key; file modes 0600/0700;
   manifest contains no password; `config.test.ts` endpoint-credentials refusal.
8. Integrity → "refuses a modified dump before touching the database"; `manifest.test.ts`.
9. Docs → `docs/backup-restore.md`, linked from `docs/install.md`.

- Migration lock → "does not run alongside a migration…".
- CLI smoke (built binary): backup → restore → restore again refused ("already has data").
