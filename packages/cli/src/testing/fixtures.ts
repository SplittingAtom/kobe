import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLOB_REF_COLUMNS } from "@kobe/db";
import { createTestDatabase, type TestDatabase } from "@kobe/db/testing";
import pg from "pg";
import { decryptFile, deriveKeys } from "../crypto.js";
import {
  MANIFEST_FILE,
  readSignedManifest,
  writeSignedManifest,
  type Manifest,
} from "../manifest.js";
import type { ObjectLister, StoredObject } from "../objects.js";
import { pgBinary, runTool } from "../pg-tools.js";

// Fixtures for the backup/restore round-trip tests (not part of the build).

/** Rows in excluded tables: must not be in the backup even after decryption. */
export const EXCLUDED_MARKERS = {
  session: "SESSION-TOKEN-PLAINTEXT-1f2e3d",
  reset: "RESET-TOKEN-PLAINTEXT-4a5b6c",
  jwks: "JWKS-PRIVATE-KEY-7d8e9f",
  rateLimit: "RATE-LIMIT-KEY-9e8d7c",
} as const;
/**
 * Better Auth OAuth tokens in `accounts` (if SSO providers are added). `accounts` IS backed up, so
 * these are in the decrypted dump: protected by the backup encryption only.
 */
export const OAUTH_TOKENS = {
  oauthAccess: "OAUTH-ACCESS-TOKEN-0a1b2c",
  oauthRefresh: "OAUTH-REFRESH-TOKEN-3d4e5f",
  oauthId: "OAUTH-ID-TOKEN-6a7b8c",
} as const;
const SECRETS = { ...EXCLUDED_MARKERS, ...OAUTH_TOKENS };
/** Ordinary data: in the decrypted dump, never readable in the backup files themselves. */
export const PERSONAL_DATA = ["ann@example.com", "scrypt:salt:hash", "enc:totp", "beta-only"];
const { session: SESSION_TOKEN, reset: RESET_TOKEN, jwks: JWKS_PRIVATE } = SECRETS;

export const T1 = "00000000-0000-4000-8000-0000000000a1";
export const T2 = "00000000-0000-4000-8000-0000000000a2";
/** The dedicated Registry team (KOBE-330): only a `registry` team can be named the Registry team. */
export const T_REGISTRY = "00000000-0000-4000-8000-0000000000a3";
export const U1 = "00000000-0000-4000-8000-0000000000b1";
export const U2 = "00000000-0000-4000-8000-0000000000b2";
export const THREAD = "00000000-0000-4000-8000-0000000000c1";
export const U3 = "00000000-0000-4000-8000-0000000000b3";
/** A word in a seeded message: its generated tsv must be recomputed by the restore (KOBE-33). */
export const SEARCH_WORD = "zebrafish";

export const OBJECTS: StoredObject[] = [
  { key: "teams/a1/uploads/report.csv", size: 1234, etag: '"e1"' },
  { key: "teams/a2/artifacts/chart.html", size: 99, etag: '"e2"' },
];

export function memoryLister(objects: readonly StoredObject[]): ObjectLister {
  return {
    location: { endpoint: "memory://test", bucket: "kobe", prefix: "" },
    async *list() {
      yield* objects;
    },
  };
}

export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  url: string,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

/**
 * A table "added by a later ticket": team-scoped with FORCE RLS, a self-referencing foreign key
 * (children stored before parents) and a serial. Its absence from any backup code proves new
 * tables are covered automatically.
 */
export const WIDGETS = `
  CREATE TABLE widgets (
    team_id uuid NOT NULL REFERENCES teams(id),
    id serial PRIMARY KEY,
    parent_id int REFERENCES widgets(id),
    name text NOT NULL,
    blob_ref text
  );
  ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE widgets FORCE ROW LEVEL SECURITY;
  CREATE POLICY team_isolation ON widgets
    USING (team_id = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
    WITH CHECK (team_id = NULLIF(current_setting('kobe.team_id', true), '')::uuid);`;

/** A business trigger that must not fire while restoring (and must be back afterwards). */
export const GUARD_TRIGGER = `
  CREATE FUNCTION widgets_guard() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'business trigger fired'; END $$;
  CREATE TRIGGER widgets_guard BEFORE INSERT ON widgets FOR EACH ROW EXECUTE FUNCTION widgets_guard();`;

export async function seed(db: TestDatabase): Promise<void> {
  await sql(db.ownerUrl, WIDGETS);
  // The superuser bypasses RLS, standing in for an app that wrote through withTeam().
  await sql(
    db.adminUrl,
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'alpha', 'Alpha'), ($2, 'beta', 'Beta');
     INSERT INTO teams (id, slug, name, registry) VALUES ($6, 'registry', 'Registry', true);
     INSERT INTO users (id, name, email) VALUES ($3, 'Ann', 'ann@example.com'),
       ($4, 'Bob', 'bob@example.com'), ($5, 'Cy', 'cy@example.com');
     INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $3, 'team_admin'),
       ($1, $4, 'member'), ($2, $5, 'team_admin');
     INSERT INTO accounts (user_id, account_id, provider_id, password)
       VALUES ($3, $3, 'credential', 'scrypt:salt:hash');
     -- A future OAuth/SSO provider (Better Auth stores these tokens in plaintext by default).
     INSERT INTO accounts (user_id, account_id, provider_id, access_token, refresh_token, id_token)
       VALUES ($4, 'gh-42', 'github', '${SECRETS.oauthAccess}', '${SECRETS.oauthRefresh}', '${SECRETS.oauthId}');
     INSERT INTO site_roles (user_id, role) VALUES ($3, 'owner');
     INSERT INTO site_settings (key, value) VALUES ('require_2fa', 'false');
     INSERT INTO two_factors (user_id, secret, backup_codes) VALUES ($3, 'enc:totp', 'enc:codes');
     INSERT INTO sessions (user_id, token, expires_at) VALUES ($3, '${SESSION_TOKEN}', now() + interval '1 day');
     INSERT INTO verifications (identifier, value, expires_at) VALUES ('reset', '${RESET_TOKEN}', now() + interval '1 hour');
     INSERT INTO jwks (public_key, private_key) VALUES ('pub', '${JWKS_PRIVATE}');
     INSERT INTO rate_limits (key, count, last_request) VALUES ('${EXCLUDED_MARKERS.rateLimit}', 3, 1);
     INSERT INTO widgets (team_id, id, parent_id, name, blob_ref) VALUES
       ($1, 1, 2, 'child', 'teams/a1/uploads/report.csv'), ($1, 2, NULL, 'parent', NULL),
       ($2, 3, NULL, 'beta-only', NULL);
     SELECT setval('widgets_id_seq', 3);
     -- A conversation: entries chain to their parent, the thread points at its leaf entry (an FK
     -- cycle threads <-> thread_entries); triggers assign seq. One entry's payload lives in S3.
     -- e1 is a Pi user message, so its generated search column (KOBE-33) is non-null.
     INSERT INTO threads (team_id, id, owner_user_id, title) VALUES ($1, '${THREAD}', $3, 'Q3 report');
     INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload, blob_ref) VALUES
       ($1, '${THREAD}', 'e1', NULL, 'message', '{"message":{"role":"user","content":"${SEARCH_WORD} forecast"}}', NULL),
       ($1, '${THREAD}', 'e2', 'e1', 'message', '{}', 'teams/a2/artifacts/chart.html');
     UPDATE threads SET leaf_entry_id = 'e2' WHERE team_id = $1 AND id = '${THREAD}';
     -- The Skills Catalog (KOBE-311): migration-seeded rows (the Default tag, the settings row)
     -- the backup must bring back with their own ids and values, and rows that reference them.
     INSERT INTO registry_tags (name, kind) VALUES ('finance', 'topic');
     INSERT INTO registry_skills (id, name, summary)
       VALUES ('5e6f7a8b-0000-4000-8000-0000000000c1', 'tagged', 'Tagged.');
     INSERT INTO registry_skill_tags (skill_id, tag_id, added_by)
       SELECT '5e6f7a8b-0000-4000-8000-0000000000c1', id, $3 FROM registry_tags;
     UPDATE site_skill_settings SET registry_team_id = $6, judge_alias = 'smart';
     -- Audit events (KOBE-15): the trigger chains them; the restore must keep the chain intact.
     -- Both carry a client address (salted commitment, KOBE-17); the first one's IP and user agent
     -- were erased since, as the retention sweep does (here directly, bypassing its age check).
     INSERT INTO audit_log (actor_kind, actor_id, team_id, action, target, ip, user_agent) VALUES
       ('user', $3, NULL, 'auth.sign_in.succeeded', '{"method":"password"}', '203.0.113.5', 'UA'),
       ('user', $3, $1, 'identity.member.role_changed',
        jsonb_build_object('userId', $4, 'from', 'builder', 'to', 'member'), '203.0.113.6', 'UA');
     SET session_replication_role = replica;
     UPDATE audit_log SET ip = NULL, user_agent = NULL, pii_salt = NULL WHERE seq = 1;
     SET session_replication_role = origin;`.replaceAll(
      /\$(\d)/g,
      (_, n: string) => `'${[T1, T2, U1, U2, U3, T_REGISTRY][Number(n) - 1]}'`,
    ),
  );
}

/**
 * What the server's start writes into a site before anyone signs up (KOBE-422, the rows
 * `@kobe/db` STARTUP_SEEDED_ROWS covers): the gallery agent `kobe` and its published version,
 * the seed's two audit events, the retention pass's, PII sweep's and SIEM forwarder's
 * bookkeeping, and the catalog usage job's snapshot of the last closed window (KOBE-339; the
 * same window on every site started that day, so a restore that kept it would collide).
 */
const USAGE_WINDOW = "2026-10-17T00:00:00.000Z";

export async function serverStarted(url: string, agentId = randomUUID()): Promise<string> {
  await sql(
    url,
    `INSERT INTO site_agents (id, scope, slug, frontmatter, prompt, gallery_key, gallery_generation)
       VALUES ('${agentId}', 'gallery', 'kobe', '{"name":"Kobe"}', 'You are Kobe.', 'kobe', 1);
     INSERT INTO site_agent_versions (agent_id, version, frontmatter, prompt, tool_manifest, draft_revision)
       VALUES ('${agentId}', 1, '{"name":"Kobe"}', 'You are Kobe.', '{}', 1);
     UPDATE site_agents SET current_version = 1 WHERE id = '${agentId}';
     INSERT INTO audit_log (actor_kind, action, target) VALUES
       ('system', 'agent.created', jsonb_build_object('agentId', '${agentId}', 'scope', 'gallery', 'slug', 'kobe', 'source', 'seed')),
       ('system', 'agent.published', jsonb_build_object('agentId', '${agentId}', 'scope', 'gallery', 'slug', 'kobe', 'version', 1));
     INSERT INTO site_settings (key, value) VALUES
       ('retention.pass_started_at', '2026-10-18T03:00:00.000Z'),
       ('retention.last_pass_at', '2026-10-18T03:00:00.000Z'), ('retention.cursor', ''),
       ('audit.pii_sweep_seq', '2'),
       ('audit.forward.syslog', '{"seq":2,"failures":1}');
     INSERT INTO skill_usage_snapshots (window_start, window_end, payload)
       VALUES ('${USAGE_WINDOW}', '2026-10-18T00:00:00.000Z', '{"skills":{}}');`,
  );
  return agentId;
}

/** A freshly installed target: migrated by Kobe, same schema, no data. */
export async function freshTarget(server: string): Promise<TestDatabase> {
  const db = await createTestDatabase(server);
  await sql(db.ownerUrl, WIDGETS + GUARD_TRIGGER);
  // The new site's server already generated its own signing key; it must survive the restore.
  await sql(
    db.adminUrl,
    `INSERT INTO jwks (public_key, private_key) VALUES ('new-pub', 'new-enc')`,
  );
  return db;
}

export async function rowsOf(url: string, table: string): Promise<string[]> {
  const rows = await sql<{ r: string }>(
    url,
    `SELECT to_jsonb(t)::text AS r FROM public."${table}" t ORDER BY 1`,
  );
  return rows.map((r) => r.r);
}

export async function forcedTables(url: string): Promise<string[]> {
  const rows = await sql<{ name: string }>(
    url,
    `SELECT relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity ORDER BY 1`,
  );
  return rows.map((r) => r.name);
}

/** The real registry plus the test table's blob-ref column (registered for these tests only). */
export const BLOB_REFS = [...BLOB_REF_COLUMNS, { table: "widgets", column: "blob_ref" }];

/** Every byte of every file in a backup directory, for plaintext-leak checks. */
export async function allBackupBytes(dir: string): Promise<Buffer> {
  const files = await readdir(dir);
  return Buffer.concat(await Promise.all(files.map((f) => readFile(join(dir, f)))));
}

/** The pg_restore SQL script inside a backup (decrypted with `key`). */
export async function dumpScript(dir: string, key: Buffer, pgBinDir?: string): Promise<string> {
  const { manifest, keys } = await readSignedManifest(dir, key);
  const work = await mkdtemp(join(tmpdir(), "kobe-dump-"));
  try {
    const ref = manifest.files.database;
    await decryptFile(keys.enc, ref.path, join(dir, ref.path), ref, join(work, "d"));
    return await runTool(pgBinary("pg_restore", pgBinDir), [
      "--data-only",
      "--file=-",
      join(work, "d"),
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Copies a backup and edits its manifest, re-signing it with `key` (a key holder's tampering). */
export async function copyWithManifest(
  from: string,
  to: string,
  key: Buffer,
  edit: (m: Manifest) => Manifest,
): Promise<void> {
  await cp(from, to, { recursive: true });
  const m = JSON.parse(await readFile(join(to, MANIFEST_FILE), "utf8")) as Manifest;
  await writeSignedManifest(to, edit(m), deriveKeys(key, Buffer.from(m.encryption.salt, "hex")));
}

/**
 * A directory of fake pg_dump/pg_restore/psql that record being run, to prove a refused backup
 * never reaches a client tool.
 */
export async function trapBinDir(): Promise<{ dir: string; ran: () => Promise<boolean> }> {
  const dir = await mkdtemp(join(tmpdir(), "kobe-trap-"));
  const marker = join(dir, "ran");
  for (const tool of ["pg_dump", "pg_restore", "psql"]) {
    await writeFile(join(dir, tool), `#!/bin/sh\necho "$0" >> "${marker}"\nexit 1\n`, {
      mode: 0o755,
    });
  }
  return {
    dir,
    ran: async () => {
      try {
        await stat(marker);
        return true;
      } catch {
        return false;
      }
    },
  };
}
