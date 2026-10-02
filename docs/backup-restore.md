# Backup and restore

`kobe backup` and `kobe restore` (spec D31) back up Kobe's durable record (Postgres) together
with a manifest of the objects in the external S3 bucket. Sandbox volumes are not backed up because
they are rebuildable working copies (spec D15).

## What a backup contains

A backup is a new directory (mode `0700`, files `0600`). Every backup is **encrypted and signed**
with the operator's backup key. There is no plaintext mode.

| File                | Contents                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `database.dump.enc` | `pg_dump` custom-format **data** of every table in `public`, AES-256-GCM encrypted (schema comes from migrations) |
| `objects.jsonl.enc` | Every object in the S3 bucket (key, size, ETag), AES-256-GCM encrypted                                            |
| `manifest.json`     | Format, time, Postgres versions, applied migrations, per-table row counts, coverage, ciphertext checksums, IVs    |
| `manifest.json.sig` | HMAC-SHA256 of `manifest.json`                                                                                    |

- **New tables are included automatically.** Every table in `public` is backed up unless it is on
  the short exclusion list in `packages/cli/src/excluded.ts`.
- **Coverage is checked.** The backup refuses to run when data exists that a dump of `public`
  would skip: tables, materialized views or foreign tables in other schemas (apart from Kobe's
  migration bookkeeping in `drizzle`), and large objects. The manifest records that this check
  ran.
- **Not backed up (by design):**

  | Table                  | Why                                                                                                 |
  | ---------------------- | --------------------------------------------------------------------------------------------------- |
  | `sessions`             | bearer session tokens; after a restore everyone signs in again                                      |
  | `verifications`        | one-time email-verification and password-reset tokens                                               |
  | `jwks`                 | JWT signing keys; the server generates a new one on first use                                       |
  | `rate_limits`          | throwaway counters                                                                                  |
  | `session_active_teams` | per-session pointer to the active team; it references `sessions`, so its rows could not be restored |

- **Schema, grants and the migration journal are not in the dump.** The target gets them from
  Kobe's own migrations (`helm install`). Objects therefore stay owned by the owner role, and the
  app role keeps exactly the grants matrix and RLS policies of that release.
- **Snapshot consistency.** Row counts, the migration journal, blob references and the dump all
  come from one exported Postgres snapshot. The bucket is listed right after that snapshot is
  taken. While it runs, the backup holds the migration lock (shared): an upgrade's migration Job
  waits and fails after 10 s, so don't upgrade during a backup.

### Encryption and the backup key

Generate the key once and keep it in your secret store, next to the Kubernetes Secrets. **Without
the key, a backup cannot be restored.**

```bash
openssl rand -base64 32 > kobe-backup.key && chmod 600 kobe-backup.key
export KOBE_BACKUP_KEY_FILE=$PWD/kobe-backup.key     # or KOBE_BACKUP_KEY=<the key>, never argv
```

The key must be at least 32 bytes of random data, given as base64 or hex. Keys with fewer than 16
distinct byte values are refused because they look typed or patterned. `kobe` warns when the key
file is readable by group or others.

Each backup draws a random salt and uses HKDF-SHA256 to derive two keys from it: an AES-256-GCM key
for the files and an HMAC-SHA256 key for the manifest. Because the manifest records each file's
ciphertext checksum, its signature covers the whole backup. Before running any tool, a restore:

1. verifies the manifest signature,
2. checks the file checksums, and
3. decrypts the files in full and checks their GCM tags, writing into a private (`0700`)
   temporary directory that it deletes afterwards.

A modified file, a re-written manifest, a missing signature, a bad GCM tag or the wrong key are
all refused at this point.

`psql` runs without `psqlrc` and with `ON_ERROR_STOP`. The client must be 17.6+, so that
`pg_restore` wraps its script in `\restrict <key>` and psql refuses meta-commands (such as `\!`)
from inside the archive. As defence in depth, `kobe` holds the script back until it has seen that
the script starts with `\restrict`. It also refuses to commit unless the script ends with the
matching `\unrestrict`.

**Where the plaintext lives during a restore.** The decrypted dump sits in a private temporary
directory for the length of the restore. That directory is `KOBE_TMPDIR` if set, otherwise the OS
temp directory, and it is deleted:

- at the end of the restore, whether it succeeds or fails;
- on `SIGINT`, `SIGTERM` or `SIGHUP` (Ctrl-C, a Job deadline, pod deletion), after which `kobe`
  exits non-zero and Postgres rolls back.

A `SIGKILL` cannot be caught. Point `KOBE_TMPDIR` at memory-backed storage so the plaintext never
reaches a disk:

- Linux: `/dev/shm`, or any tmpfs.
- Kubernetes Job: an `emptyDir` with `medium: Memory`, sized to hold the dump (`sizeLimit`). It
  counts against the pod's memory limit.

**Limits.** Each file is a single AES-256-GCM message, and GCM caps one message at just under
64 GiB. A database whose compressed dump is larger than that is not supported by this format.

### Secrets

A backup file never holds plaintext, because everything is encrypted under the backup key. Once
decrypted, the dump contains every backed-up table, **including `accounts`**. Should a sign-in
provider ever store OAuth tokens there, those tokens are in the dump too, and they are protected
only by the backup encryption. The test suite seeds such tokens and asserts exactly this. Inside
the encryption:

| Data                                          | Inside the backup as                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| Passwords                                     | scrypt hashes (`accounts.password`)                                         |
| TOTP secrets and backup codes                 | ciphertext under the **auth secret** (`two_factors`)                        |
| OAuth tokens in `accounts` (if SSO is added)  | **as stored** (plaintext inside the encrypted dump)                         |
| Connector grants, header injection (later)    | ciphertext under an install key held in a Kubernetes Secret (spec D27, D28) |
| Sessions, reset tokens, JWT keys, rate limits | not included (absent even from the decrypted dump; tested)                  |

Even so, a backup holds personal data (names, e-mail addresses, and conversations once they
exist). Restrict who can read the backup files and who can read the key.

**The Kubernetes Secrets are not in the backup**, and a restore needs them. When you install, keep
copies of the following in your secret store:

- The auth Secret (`<release>-auth`, key `secret`). Without the same value, every enrolled TOTP
  factor is unusable after a restore. Rotating it is not supported (see `auth.existingSecret`).
- The backup key, the S3 credentials, the database credentials, and (later) the install
  encryption key.

### Object storage

The backup does not copy S3 objects; spec D31 settles this. Object durability is the bucket's job:
**enable bucket versioning, and object lock or replication**, so that objects deleted or
overwritten by mistake can be recovered.

The backup records what existed. It also checks, inside its Postgres snapshot, that every object
key stored in a blob-ref column is in that listing, and refuses to continue otherwise. Blob-ref
columns are listed in `BLOB_REF_COLUMNS` (`packages/db/src/blob-refs.ts`); tables that store object
keys add their column there. The restore compares the bucket with the listing. A missing object,
or one whose size or ETag differs, stops the restore unless you pass `--allow-object-mismatch`.
Objects in the bucket that are not in the backup are left alone.

`--no-objects` skips the listing at backup time or the check at restore time, and prints a
warning either way. Without it, a restore refuses to run when the backup has a listing but no
object storage is configured.

## Requirements

- **PostgreSQL client 17.6 or newer** (`pg_dump`, `pg_restore`, `psql`), either on `PATH` or in the
  directory named by `KOBE_PG_BIN_DIR`:
  - Debian/Ubuntu: `postgresql-client-17` from PGDG.
  - macOS: `brew install libpq`, then `KOBE_PG_BIN_DIR=$(brew --prefix libpq)/bin`.

  The client must not be older than the server, and a restore needs the same client as the backup
  or a newer one.

- The CLI: run `pnpm install && pnpm build`, then `node packages/cli/dist/cli.js` (called `kobe`
  below).
- Network access to Postgres (for example with `kubectl port-forward`) and to the S3 endpoint.
  `kobe` warns when a remote database is reached without `sslmode=require` or `verify-full`.
- Child tools get a minimal environment (`PATH`, `HOME`, locale and libpq's `PG*` settings). S3
  credentials and the backup key are never passed to them.

### Roles

| Command        | Connects as                                                          | Why                                                                                                         |
| -------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `kobe backup`  | a **backup role**: `BYPASSRLS` + `pg_read_all_data` (or a superuser) | every team table forces RLS, so any other role would silently miss team rows; the backup refuses such roles |
| `kobe restore` | the **owner role** (the chart's `migrate-url`)                       | it owns every table, so it can lift `FORCE ROW LEVEL SECURITY` for itself inside the restore transaction    |

The app role is never used. Create a dedicated backup user once, as a superuser. Put its password
in a Kubernetes Secret or your secret store, not in shell history: the `\password` prompt below
avoids typing it on a command line.

```bash
kubectl -n kobe exec -it kobe-pg-1 -c postgres -- psql -d kobe   # CloudNativePG primary
```

```sql
CREATE ROLE kobe_backup LOGIN NOSUPERUSER BYPASSRLS IN ROLE pg_read_all_data;
\password kobe_backup
```

CloudNativePG leaves unmanaged roles alone. With external Postgres, run the same statements as
your administrator.

## Back up

```bash
kubectl -n kobe port-forward svc/kobe-pg-rw 5432:5432 &   # CloudNativePG; or reach your Postgres

export KOBE_BACKUP_KEY_FILE=/secure/kobe-backup.key
export KOBE_BACKUP_DATABASE_URL="postgres://kobe_backup:$(cat /secure/kobe-backup-db-password)@localhost:5432/kobe"
export KOBE_S3_ENDPOINT=https://s3.example.com KOBE_S3_BUCKET=kobe KOBE_S3_REGION=us-east-1
export KOBE_S3_ACCESS_KEY_ID=... KOBE_S3_SECRET_ACCESS_KEY=...   # read-only (List) is enough

kobe backup --out /backups/kobe-$(date -u +%Y%m%dT%H%M%SZ)
```

The directory must not exist yet. The backup is written to `<dir>.partial` and renamed when it
is complete, so a directory without `.partial` holds a finished backup.

`kobe backup` prints the backup's **manifest fingerprint** (sha256 of `manifest.json`) and its
creation time. Record both outside the backup storage, for example in your runbook or ticket.
`kobe restore` prints the same two values before it loads anything, so you can confirm you are
restoring the backup you meant to. The signature proves a backup is genuine. It cannot tell you
whether someone with write access to the backup store swapped in an older genuine backup; the
recorded fingerprint can.

## Restore onto a fresh cluster

A restore goes into a **freshly installed Kobe of the same version** (same migrations). It refuses
a target whose applied migrations differ or that already has data, and it never deletes anything.

1. Recreate the Secrets from your secret store. Give the auth Secret a new name so that Helm
   does not have to adopt it:

   ```bash
   kubectl -n kobe create secret generic kobe-auth-restored \
     --from-file=secret=/secure/kobe-auth-secret --from-literal=setup-token="$(openssl rand -hex 16)"
   ```

2. Install the Kobe version the backup was taken with (see [install.md](install.md)), and:
   - add `--set auth.existingSecret=kobe-auth-restored`;
   - use the same S3 bucket, or one that holds a copy of its objects;
   - use the same public URL, because passkeys are bound to it.

   Don't run first-run setup: a restore refuses a database that already has users.

3. Stop the writers: `kubectl -n kobe scale deploy/kobe-server deploy/kobe-scheduler --replicas=0`.
4. Restore as the owner role:

   ```bash
   kubectl -n kobe port-forward svc/kobe-pg-rw 5432:5432 &
   # CloudNativePG owner credentials: secret kobe-pg-app (username, password)
   export KOBE_BACKUP_KEY_FILE=/secure/kobe-backup.key
   export KOBE_DB_MIGRATE_URL="postgres://kobe_owner:$(kubectl -n kobe get secret kobe-pg-app -o jsonpath='{.data.password}' | base64 -d)@localhost:5432/kobe"
   export KOBE_S3_ENDPOINT=... KOBE_S3_BUCKET=... KOBE_S3_ACCESS_KEY_ID=... KOBE_S3_SECRET_ACCESS_KEY=...
   export KOBE_TMPDIR=/dev/shm          # memory-backed; the decrypted dump never touches disk
   kobe restore --from /backups/kobe-20261002T120000Z
   ```

   Before the load starts, check that the printed fingerprint and creation time match the
   values you recorded when the backup was taken.

5. Scale back up, either with `helm upgrade` using the same values or with
   `kubectl scale ... --replicas=<n>`. Users have to sign in again; enrolled passkeys and TOTP
   keep working.

How restore works:

1. Authenticates and decrypts the backup (see [Encryption](#encryption-and-the-backup-key)).
2. Checks the target: the connected role owns every table, the applied migrations equal the
   backup's, and the table sets match.
3. Compares the bucket with the backup's object listing (see [Object storage](#object-storage)).
4. Streams `pg_restore --data-only` into **one `psql` transaction**. That transaction:
   - takes the migration lock and locks every table;
   - lifts `FORCE ROW LEVEL SECURITY` for the owner only (the app role stays bound by RLS);
   - disables user triggers (e.g. the `seq`-assigning triggers on `thread_entries` and
     `run_events`, so the backed-up `seq` values are kept) and defers foreign keys;
   - re-checks the migrations and that the target is empty;
   - loads the data and verifies every table's row count against the manifest;
   - restores the triggers and FORCE RLS, and commits.

   Any error rolls everything back, and so does the CLI dying.

5. Error output names Kobe's own checks in full. Any other server error appears only as its
   SQLSTATE, because Postgres messages and DETAIL/CONTEXT lines can quote row data. Look up the
   full error in the Postgres server log.

### Limits

- Only same-version restores are supported. To move a backup to a newer Kobe, restore it on its
  own version and then run `helm upgrade`, which runs the migrations as usual.
- Foreign keys: inside the transaction, every non-deferrable foreign key is made `DEFERRABLE
INITIALLY DEFERRED` (the owner may do this), so FK cycles such as `threads.leaf_entry_id` ⇄
  `thread_entries` load in any order. All keys are checked before the commit and then made
  immediate again; a violation rolls everything back.
- Sequence positions (`setval`) are not transactional. After a failed restore, the target's
  sequences may already have moved forward. This is harmless (ids skip), but the target is not
  byte-identical to a fresh install.
- Each backup is a full copy, and there is no point-in-time recovery. For that, use
  CloudNativePG's own backups or your managed Postgres in addition.
