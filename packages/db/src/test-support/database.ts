import { randomBytes } from "node:crypto";
import pg from "pg";
import { DEFAULT_MIGRATIONS_FOLDER, runMigrations } from "../migrate.js";
import { assertAllMigrationsApplied, assertJournalExtendsBase } from "./upgrade.js";

export interface TestDatabase {
  /** Superuser URL to the throwaway database (tests only). */
  readonly adminUrl: string;
  readonly ownerUrl: string;
  readonly ownerRole: string;
  readonly appUrl: string;
  readonly appRole: string;
  drop(): Promise<void>;
}

/**
 * Creates a throwaway database with a separate owner role (runs migrations) and app role
 * (NOSUPERUSER NOBYPASSRLS, owns nothing), migrated from scratch, or, when
 * KOBE_TEST_BASE_MIGRATIONS names a base branch's migrations folder, upgraded from it. `serverUrl` is a superuser URL
 * to a Postgres 17 server, used only to create and drop the database and roles.
 */
export async function createTestDatabase(serverUrl: string): Promise<TestDatabase> {
  const suffix = randomBytes(4).toString("hex");
  const dbName = `kobe_test_${suffix}`;
  const ownerRole = `kobe_owner_${suffix}`;
  const appRole = `kobe_app_${suffix}`;
  const password = randomBytes(16).toString("hex");
  const urlFor = (user: string): string => {
    const url = new URL(serverUrl);
    url.username = user;
    url.password = password;
    url.pathname = `/${dbName}`;
    return url.toString();
  };

  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  const drop = async (): Promise<void> => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${appRole}`);
    await admin.query(`DROP ROLE IF EXISTS ${ownerRole}`);
    await admin.end();
  };

  try {
    await admin.query(
      `CREATE ROLE ${ownerRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`,
    );
    await admin.query(
      `CREATE ROLE ${appRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`,
    );
    await admin.query(`CREATE DATABASE ${dbName} OWNER ${ownerRole}`);
    const baseFolder = process.env.KOBE_TEST_BASE_MIGRATIONS;
    if (baseFolder) {
      // Upgrade path (KOBE-69): the base branch's migrations first, then this branch's on top,
      // through the same runner the chart's migration Job uses.
      assertJournalExtendsBase(baseFolder, DEFAULT_MIGRATIONS_FOLDER);
      await runMigrations({
        databaseUrl: urlFor(ownerRole),
        appRole,
        migrationsFolder: baseFolder,
      });
      await runMigrations({ databaseUrl: urlFor(ownerRole), appRole });
      await assertAllMigrationsApplied(urlFor(ownerRole), DEFAULT_MIGRATIONS_FOLDER);
    } else {
      await runMigrations({ databaseUrl: urlFor(ownerRole), appRole });
    }
  } catch (err) {
    await drop();
    throw err;
  }

  const adminUrl = new URL(serverUrl);
  adminUrl.pathname = `/${dbName}`;
  return {
    adminUrl: adminUrl.toString(),
    ownerUrl: urlFor(ownerRole),
    ownerRole,
    appUrl: urlFor(appRole),
    appRole,
    drop,
  };
}

/** Reads KOBE_TEST_DATABASE_URL or fails with an explanation (db tests never silently skip). */
export function testServerUrl(): string {
  const url = process.env.KOBE_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "KOBE_TEST_DATABASE_URL is required for db tests: a superuser URL to a Postgres 17 server " +
        "(used only to create and drop a throwaway database and roles).",
    );
  }
  return url;
}

export interface BackdatedAuditRow {
  readonly hours: number;
  readonly actorId?: string | null;
  readonly teamId?: string | null;
  readonly ip?: string;
  readonly userAgent?: string;
}

/**
 * Tests only: appends an `auth.sign_out` audit row as if recorded `hours` ago, with an IP and user
 * agent (KOBE-17 erasure tests). Built at the head of the chain by a superuser with the database's
 * own functions (triggers skipped for this transaction), so the chain stays valid. Returns its seq.
 */
export async function appendBackdatedAuditRow(
  superuser: string | pg.Client,
  row: BackdatedAuditRow,
): Promise<number> {
  const own = typeof superuser === "string";
  const client = own ? new pg.Client({ connectionString: superuser }) : superuser;
  if (own) await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('kobe.audit_log', 0))`);
    const { rows } = await client.query<{ seq: string }>(
      `INSERT INTO audit_log (seq, at, team_id, actor_kind, actor_id, action, target, ip, user_agent,
                              prev_hash, hash_version, pii_salt, pii_commitment)
       SELECT coalesce(h.seq, 0) + 1, now() - make_interval(hours => $1), $2, 'user', $3,
              'auth.sign_out', '{}', $4, $5, coalesce(h.hash, repeat('0', 64)), 2,
              replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
              repeat('0', 64)
       FROM (SELECT 1) one
       LEFT JOIN (SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1) h ON true
       RETURNING seq::text`,
      [
        row.hours,
        row.teamId ?? null,
        row.actorId ?? null,
        row.ip ?? "203.0.113.7",
        row.userAgent ?? "test agent",
      ],
    );
    const seq = Number(rows[0]?.seq);
    await client.query(
      `UPDATE audit_log a SET pii_commitment = audit_log_digest(audit_log_pii_canonical(a)) WHERE seq = $1`,
      [seq],
    );
    await client.query(
      `UPDATE audit_log a SET hash = audit_log_digest(audit_log_canonical(a)) WHERE seq = $1`,
      [seq],
    );
    await client.query("COMMIT");
    return seq;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    if (own) await client.end();
  }
}
