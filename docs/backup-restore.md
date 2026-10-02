# Backup and restore

`kobe backup` and `kobe restore` (spec D31) back up Kobe's durable record — Postgres — and a
manifest of the objects in the external S3 bucket. Sandbox volumes are not backed up: they are
rebuildable working copies (spec D15).

## What a backup contains

A backup is a new directory (mode `0700`, files `0600`):

| File            | Contents                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------ |
| `database.dump` | `pg_dump` custom-format **data** of every table in `public` (schema comes from migrations) |
| `objects.jsonl` | Every object in the S3 bucket (key, size, ETag) at backup time                             |
| `manifest.json` | Format, time, Postgres versions, the applied migrations, per-table row counts, checksums   |

- **New tables are included automatically.** Every table in `public` is backed up unless it is on
  the short exclusion list in `packages/cli/src/excluded.ts`.
- **Not backed up (by design):**

  | Table           | Why                                                            |
  | --------------- | -------------------------------------------------------------- |
  | `sessions`      | bearer session tokens; after a restore everyone signs in again |
  | `verifications` | one-time email-verification and password-reset tokens          |
  | `jwks`          | JWT signing keys; the server generates a new one on first use  |
  | `rate_limits`   | throwaway counters                                             |

- **Schema, grants and the migration journal are not in the dump.** The target gets them from
  Kobe's own migrations (`helm install`), so objects stay owned by the owner role and the app role
  keeps exactly the grants matrix and RLS policies of that release.
- **Snapshot consistency.** Row counts, the migration journal and the dump come from one exported
  Postgres snapshot; the backup holds the migration lock (shared) while it runs, so an upgrade's
  migration Job waits (and fails after 10 s) — don't upgrade during a backup.
- **S3 data is not copied.** Object storage is external and keeps its own durability (use bucket
  versioning or replication). The backup records what existed; the restore checks that it still
  does.

### Secrets

No plaintext credentials are written to a backup. What remains is protected at rest:

| Data                                       | In the backup as                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Passwords                                  | scrypt hashes (`accounts.password`)                                         |
| TOTP secrets and backup codes              | ciphertext under the **auth secret** (`two_factors`)                        |
| Connector grants, header injection (later) | ciphertext under an install key held in a Kubernetes Secret (spec D27, D28) |
| Session/reset tokens, JWT signing keys     | not included                                                                |

The backup still holds personal data (names, e-mail addresses, conversations once they exist).
Store it encrypted at rest with access restricted to operators.

**The Kubernetes Secrets are not in the backup** and a restore needs them. Keep copies in your
secret store when you install, and at least:

- the auth Secret (`<release>-auth`, key `secret`): without the same value every enrolled TOTP
  factor is unusable after a restore. Rotating it is not supported (see `auth.existingSecret`).
- S3 credentials, database credentials, and (later) the install encryption key.

## Requirements

- **PostgreSQL client 17 or newer** (`pg_dump`, `pg_restore`, `psql`) on `PATH`, or
  `KOBE_PG_BIN_DIR` pointing at them (Debian/Ubuntu: `postgresql-client-17` from PGDG; macOS:
  `brew install libpq`, then `KOBE_PG_BIN_DIR=$(brew --prefix libpq)/bin`). The client must not be
  older than the server; restore with the same or a newer client than the backup.
- The CLI: `pnpm install && pnpm build`, then `node packages/cli/dist/cli.js` (`kobe` below).
- Network access to Postgres (e.g. `kubectl port-forward`) and to the S3 endpoint.

### Roles

| Command        | Connects as                                                          | Why                                                                                                         |
| -------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `kobe backup`  | a **backup role**: `BYPASSRLS` + `pg_read_all_data` (or a superuser) | every team table forces RLS, so any other role would silently miss team rows; the backup refuses such roles |
| `kobe restore` | the **owner role** (the chart's `migrate-url`)                       | it owns every table, so it can lift `FORCE ROW LEVEL SECURITY` for itself inside the restore transaction    |

The app role is never used. Create the backup role once (as a superuser):

```sql
CREATE ROLE kobe_backup LOGIN PASSWORD '<generated>' NOSUPERUSER BYPASSRLS IN ROLE pg_read_all_data;
```

With bundled CloudNativePG, run it in the primary pod (CloudNativePG leaves unmanaged roles alone):

```bash
kubectl -n kobe exec -it kobe-pg-1 -c postgres -- psql -d kobe -c \
  "CREATE ROLE kobe_backup LOGIN PASSWORD '<generated>' NOSUPERUSER BYPASSRLS IN ROLE pg_read_all_data"
```

## Back up

```bash
kubectl -n kobe port-forward svc/kobe-pg-rw 5432:5432 &   # CloudNativePG; or reach your Postgres

export KOBE_BACKUP_DATABASE_URL='postgres://kobe_backup:<password>@localhost:5432/kobe'
export KOBE_S3_ENDPOINT=https://s3.example.com KOBE_S3_BUCKET=kobe KOBE_S3_REGION=us-east-1
export KOBE_S3_ACCESS_KEY_ID=... KOBE_S3_SECRET_ACCESS_KEY=...   # read-only (List) is enough

kobe backup --out /backups/kobe-$(date -u +%Y%m%dT%H%M%SZ)
```

The directory must not exist; the backup is written to `<dir>.partial` and renamed when complete,
so a directory without `.partial` is a finished backup. `--no-objects` backs up Postgres only.

## Restore onto a fresh cluster

Restore goes into a **freshly installed Kobe of the same version** (same migrations): it refuses a
target whose applied migrations differ or that already has data, and never deletes anything.

1. Recreate the Secrets from your secret store, using a new name for the auth Secret so Helm does
   not have to adopt it:

   ```bash
   kubectl -n kobe create secret generic kobe-auth-restored \
     --from-literal=secret='<the old auth secret>' --from-literal=setup-token="$(openssl rand -hex 16)"
   ```

2. Install the Kobe version the backup was taken with (see [install.md](install.md)), adding
   `--set auth.existingSecret=kobe-auth-restored` and the same S3 bucket (or one holding a copy of
   its objects) and the same public URL (passkeys are bound to it). Don't run first-run setup: a
   restore refuses a database that already has users.
3. Stop the writers: `kubectl -n kobe scale deploy/kobe-server deploy/kobe-scheduler --replicas=0`.
4. Restore as the owner role:

   ```bash
   kubectl -n kobe port-forward svc/kobe-pg-rw 5432:5432 &
   # CloudNativePG owner credentials: secret kobe-pg-app (username, password)
   export KOBE_DB_MIGRATE_URL='postgres://kobe_owner:<password>@localhost:5432/kobe'
   export KOBE_S3_ENDPOINT=... KOBE_S3_BUCKET=... KOBE_S3_ACCESS_KEY_ID=... KOBE_S3_SECRET_ACCESS_KEY=...
   kobe restore --from /backups/kobe-20261002T120000Z
   ```

5. Scale back up (`helm upgrade` with the same values, or `kubectl scale ... --replicas=<n>`).
   Users sign in again; enrolled passkeys and TOTP keep working.

How restore works:

1. Validates `manifest.json` and the checksums of every file.
2. Checks the target: the connected role owns every table, the applied migrations equal the
   backup's, the table sets match.
3. Lists the S3 bucket and compares it with `objects.jsonl`. Missing objects (or objects with a
   different size) stop the restore unless `--allow-missing-objects` is given; extra objects are
   left alone.
4. Streams `pg_restore --data-only` into **one `psql` transaction** that takes the migration lock,
   locks every table, lifts `FORCE ROW LEVEL SECURITY` (for the owner only; the app role stays bound
   by RLS) and disables user triggers, re-checks the migrations and that the target is empty, loads
   the data, verifies every table's row count against the manifest, restores triggers and FORCE
   RLS, and commits. Any error — or the CLI dying — rolls everything back.

### Limits

- Same-version restores only: to move a backup to a newer Kobe, restore it on its own version and
  then `helm upgrade` (migrations run as usual).
- Data-only loads follow foreign-key order; a cycle between two tables (not a self-reference) would
  fail the restore (atomically). Kobe's schema has none.
- One backup is a full copy; there is no point-in-time recovery. For that, use CloudNativePG's own
  backups or your managed Postgres in addition.
