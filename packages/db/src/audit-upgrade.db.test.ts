import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "./audit/index.js";
import { createDb, type KobeDb } from "./client.js";
import { DEFAULT_MIGRATIONS_FOLDER, runMigrations } from "./migrate.js";
import * as schema from "./schema/index.js";
import { testServerUrl } from "./test-support/database.js";

/**
 * The audit chain v2 upgrade path (KOBE-17): an install whose log was chained by KOBE-15 (v1,
 * raw IP and user agent in the hash) migrates, keeps every stored hash (anchors stay valid), and
 * still verifies after its old rows' IP and user agent are erased, through the seal recorded in
 * `audit.chain.upgraded`.
 */

/** A copy of the migrations folder ending just before the KOBE-17 migrations. */
function migrationsBeforeKobe17(): string {
  const dir = mkdtempSync(join(tmpdir(), "kobe-migrations-"));
  cpSync(DEFAULT_MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  const first = journal.entries.findIndex((e) =>
    readFileSync(join(dir, `${e.tag}.sql`), "utf8").includes('CREATE TABLE "legal_holds"'),
  );
  if (first < 0) throw new Error("KOBE-17 migration not found");
  journal.entries = journal.entries.slice(0, first);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

interface Install {
  readonly ownerUrl: string;
  readonly appUrl: string;
  readonly adminUrl: string;
  readonly appRole: string;
  drop(): Promise<void>;
}

const server = new pg.Client({ connectionString: testServerUrl() });
const installs: Install[] = [];
let oldMigrations = "";

/** A throwaway database migrated with `folder` (owner and app roles as in production). */
async function install(folder: string): Promise<Install> {
  const suffix = randomBytes(4).toString("hex");
  const db = `kobe_up_${suffix}`;
  const ownerRole = `kobe_up_owner_${suffix}`;
  const appRole = `kobe_up_app_${suffix}`;
  const password = randomBytes(12).toString("hex");
  const url = (user: string | null) => {
    const u = new URL(testServerUrl());
    if (user) {
      u.username = user;
      u.password = password;
    }
    u.pathname = `/${db}`;
    return u.toString();
  };
  await server.query(`CREATE ROLE ${ownerRole} LOGIN PASSWORD '${password}'`);
  await server.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${password}'`);
  await server.query(`CREATE DATABASE ${db} OWNER ${ownerRole}`);
  const created: Install = {
    ownerUrl: url(ownerRole),
    appUrl: url(appRole),
    adminUrl: url(null),
    appRole,
    async drop() {
      await server.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await server.query(`DROP ROLE IF EXISTS ${appRole}`);
      await server.query(`DROP ROLE IF EXISTS ${ownerRole}`);
    },
  };
  installs.push(created);
  await runMigrations({ databaseUrl: created.ownerUrl, appRole, migrationsFolder: folder });
  return created;
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Five v1 rows as KOBE-15 wrote them, three with an IP or user agent. */
async function seedV1(i: Install): Promise<void> {
  await withClient(i.appUrl, async (c) => {
    for (const [ip, ua] of [
      ["203.0.113.1", "UA one"],
      [null, null],
      ["2001:db8::1", null],
      [null, "UA four"],
      [null, null],
    ]) {
      await c.query(
        `INSERT INTO audit_log (actor_kind, action, target, ip, user_agent)
         VALUES ('system', 'auth.sign_out', '{}', $1, $2)`,
        [ip, ua],
      );
    }
  });
}

interface Row {
  seq: number;
  hash: string;
  hash_version: number;
  ip: string | null;
  pii_salt: string | null;
  pii_commitment: string | null;
  action: string;
  target: Record<string, unknown>;
}

const rows = (url: string) =>
  withClient(url, async (c) => {
    const res = await c.query<Row>(
      `SELECT seq::int, hash, hash_version, host(ip) AS ip, pii_salt, pii_commitment, action, target
       FROM audit_log ORDER BY seq`,
    );
    return res.rows;
  });

async function verify(url: string) {
  const db = createDb(url, { max: 1 });
  try {
    const node = await verifyAuditChain(db.db);
    const { rows: sqlRows } = await db.pool.query<{
      problem_seq: number | null;
      problem: string | null;
    }>(`SELECT problem_seq::int, problem FROM audit_log_chain_problem()`);
    return { node, sql: sqlRows[0] };
  } finally {
    await db.close();
  }
}

/** Runs `tamper` as superuser with triggers off, verifies, rolls back. */
async function verifyTampered(url: string, tamper: string) {
  return withClient(url, async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(tamper);
      const { rows: sqlRows } = await c.query<{ problem_seq: number; problem: string }>(
        `SELECT problem_seq::int, problem FROM audit_log_chain_problem()`,
      );
      return sqlRows[0];
    } finally {
      await c.query("ROLLBACK");
    }
  });
}

beforeAll(async () => {
  await server.connect();
  oldMigrations = migrationsBeforeKobe17();
});

afterAll(async () => {
  for (const i of installs) await i.drop();
  await server.end();
  rmSync(oldMigrations, { recursive: true, force: true });
});

describe("chain v2 upgrade of a KOBE-15 audit log", () => {
  let up: Install;
  let before: { seq: number; hash: string }[];

  beforeAll(async () => {
    up = await install(oldMigrations);
    await seedV1(up);
    before = await withClient(up.ownerUrl, async (c) => {
      const res = await c.query<{ seq: number; hash: string }>(
        `SELECT seq::int, hash FROM audit_log ORDER BY seq`,
      );
      return res.rows;
    });
    await runMigrations({ databaseUrl: up.ownerUrl, appRole: up.appRole });
  });

  it("keeps every stored hash, marks the rows v1 and seals them in audit.chain.upgraded", async () => {
    const after = await rows(up.ownerUrl);
    expect(after.slice(0, 5).map((r) => [r.seq, r.hash, r.hash_version])).toEqual(
      before.map((r) => [r.seq, r.hash, 1]),
    );
    // Rows with an IP or user agent were given a salt and commitment; the others none.
    expect(after.slice(0, 5).map((r) => r.pii_salt !== null)).toEqual([
      true,
      false,
      true,
      true,
      false,
    ]);
    expect(
      after.slice(0, 5).every((r) => (r.pii_salt === null) === (r.pii_commitment === null)),
    ).toBe(true);
    const event = after[5];
    expect(event).toMatchObject({ seq: 6, hash_version: 2, action: "audit.chain.upgraded" });
    expect(event?.target).toMatchObject({ throughSeq: 5, rows: 5 });
    expect(event?.target.seal).toMatch(/^[0-9a-f]{64}$/);
    const report = await verify(up.appUrl);
    expect(report.node).toMatchObject({ ok: true, checked: 6 });
    expect(report.sql).toEqual({ problem_seq: null, problem: null });
  });

  it("chains new rows as v2 after the seal", async () => {
    await withClient(up.appUrl, (c) =>
      c.query(
        `INSERT INTO audit_log (actor_kind, action, target, ip) VALUES ('system', 'auth.sign_out', '{}', '198.51.100.4')`,
      ),
    );
    const last = (await rows(up.ownerUrl)).at(-1);
    expect(last).toMatchObject({ seq: 7, hash_version: 2, ip: "198.51.100.4" });
    expect((await verify(up.appUrl)).node).toMatchObject({ ok: true, checked: 7 });
  });

  it("still verifies once the v1 rows' IP and user agent are erased", async () => {
    // As the sweep would once they are past the period (the trigger's age check is tested elsewhere).
    await withClient(up.adminUrl, (c) =>
      c.query(`BEGIN; SET LOCAL session_replication_role = replica;
               UPDATE audit_log SET ip = NULL, user_agent = NULL, pii_salt = NULL
               WHERE hash_version = 1; COMMIT`),
    );
    const report = await verify(up.appUrl);
    expect(report.node).toMatchObject({ ok: true, checked: 7 });
    expect(report.sql).toEqual({ problem_seq: null, problem: null });
    // The heads anchored before the upgrade are still in the chain.
    const head = before.at(-1);
    expect((await rows(up.ownerUrl)).find((r) => r.seq === head?.seq)?.hash).toBe(head?.hash);
  });

  it("detects an edited erased v1 row through the seal, and an edited intact one by its hash", async () => {
    const node = async (tamper: string) =>
      withClient(up.adminUrl, async (c) => {
        await c.query("BEGIN");
        try {
          await c.query("SET LOCAL session_replication_role = replica");
          await c.query(tamper);
          const db = drizzle({ client: c, schema, casing: "snake_case" }) as unknown as KobeDb;
          return await verifyAuditChain(db);
        } finally {
          await c.query("ROLLBACK");
        }
      });
    const erased = `UPDATE audit_log SET target = '{"forged":true}' WHERE seq = 1`;
    expect((await node(erased)).problem).toEqual({ seq: 6, kind: "seal_mismatch" });
    expect(await verifyTampered(up.adminUrl, erased)).toEqual({
      problem_seq: 6,
      problem: "seal_mismatch",
    });
    // Faking an erasure on a row that never had an IP doesn't skip its check either.
    const faked = `UPDATE audit_log SET pii_commitment = repeat('a', 64), target = '{"x":1}' WHERE seq = 2`;
    expect((await node(faked)).problem).toEqual({ seq: 6, kind: "seal_mismatch" });
    // A v1 row after the seal is refused.
    expect(
      await verifyTampered(up.adminUrl, `UPDATE audit_log SET hash_version = 1 WHERE seq = 7`),
    ).toEqual({ problem_seq: 7, problem: "hash_mismatch" });
  });
});

describe("chain v2 migration edge cases", () => {
  it("adds nothing to an empty log (a fresh install stays empty for a restore)", async () => {
    const fresh = await install(DEFAULT_MIGRATIONS_FOLDER);
    expect(await rows(fresh.ownerUrl)).toEqual([]);
  });

  it("refuses to upgrade a broken chain instead of sealing it", async () => {
    const broken = await install(oldMigrations);
    await seedV1(broken);
    await withClient(broken.adminUrl, (c) =>
      c.query(`BEGIN; SET LOCAL session_replication_role = replica;
               UPDATE audit_log SET target = '{"forged":true}' WHERE seq = 3; COMMIT`),
    );
    const err = await runMigrations({ databaseUrl: broken.ownerUrl, appRole: broken.appRole }).then(
      () => null,
      (e: unknown) => e as { message?: string; cause?: { message?: string } },
    );
    expect(err?.cause?.message ?? err?.message).toMatch(/broken at seq 3/);
    // Nothing of the release was applied (the pending migrations run in one transaction).
    const left = await withClient(broken.ownerUrl, (c) =>
      c.query<{ missing: boolean }>(`SELECT to_regclass('public.legal_holds') IS NULL AS missing`),
    );
    expect(left.rows[0]?.missing).toBe(true);
  });
});
