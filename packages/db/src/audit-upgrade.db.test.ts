import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealAuditV1, verifyAuditChain } from "./audit/index.js";
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
  hash_version: number | null;
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

interface Physical {
  relfilenode: string;
  indexes: string[];
  xmins: string[];
}

/** What a rewrite, an index build or a row update would change. */
const physical = (url: string) =>
  withClient(url, async (c): Promise<Physical> => {
    const rel = await c.query<{ relfilenode: string; indexes: string[] }>(
      `SELECT c.relfilenode::text,
              ARRAY(SELECT indexrelid::regclass::text || ':' || ic.relfilenode
                    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                    WHERE i.indrelid = c.oid ORDER BY 1) AS indexes
       FROM pg_class c WHERE c.oid = 'public.audit_log'::regclass`,
    );
    const xmins = await c.query<{ xmin: string }>(
      `SELECT xmin::text AS xmin FROM audit_log ORDER BY seq`,
    );
    return {
      relfilenode: rel.rows[0]?.relfilenode ?? "",
      indexes: rel.rows[0]?.indexes ?? [],
      xmins: xmins.rows.map((r) => r.xmin),
    };
  });

const sealer = async (url: string) => {
  const db = createDb(url, { max: 1 });
  try {
    return await sealAuditV1(db.db, 2);
  } finally {
    await db.close();
  }
};

describe("the v2 migration takes a constant lock window (review H1)", () => {
  it("rewrites no row, builds no index and validates no constraint on a large log", async () => {
    const big = await install(oldMigrations);
    // 100k rows written like KOBE-15 rows (chain not needed: the migration no longer reads them).
    await withClient(big.adminUrl, (c) =>
      c.query(`BEGIN; SET LOCAL session_replication_role = replica;
        INSERT INTO audit_log (seq, actor_kind, action, target, ip, user_agent, prev_hash, hash)
        SELECT g, 'system', 'auth.sign_out', '{}', '203.0.113.1', 'UA', repeat('0', 64), md5(g::text)
        FROM generate_series(1, 100000) g; COMMIT`),
    );
    const before = await physical(big.ownerUrl);
    const started = Date.now();
    await runMigrations({ databaseUrl: big.ownerUrl, appRole: big.appRole });
    const ms = Date.now() - started;
    const after = await physical(big.ownerUrl);
    expect(after.relfilenode).toBe(before.relfilenode);
    expect(after.indexes).toEqual(before.indexes);
    expect(after.xmins).toEqual(before.xmins);
    const constraints = await withClient(big.ownerUrl, (c) =>
      c.query<{ name: string; validated: boolean }>(
        `SELECT conname AS name, convalidated AS validated FROM pg_constraint
         WHERE conrelid = 'public.audit_log'::regclass AND contype = 'c' AND NOT convalidated`,
      ),
    );
    expect(constraints.rows.map((r) => r.name).sort()).toEqual([
      "audit_log_hash_version",
      "audit_log_ip_host",
      "audit_log_pii_commitment_format",
      "audit_log_pii_committed",
      "audit_log_pii_salt_format",
      "audit_log_pii_salted",
      "audit_log_v1_uncommitted",
    ]);
    // Nothing appended: the seal comes later, from the server.
    const count = await withClient(big.ownerUrl, (c) =>
      c.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log`),
    );
    expect(count.rows[0]?.n).toBe(100_000);
    console.info(`chain v2 migration over 100k audit rows: ${ms} ms (all KOBE-17 migrations)`);
  }, 120_000);
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

  it("keeps every stored hash and still verifies the v1 rows as they are", async () => {
    const after = await rows(up.ownerUrl);
    expect(after.map((r) => [r.seq, r.hash, r.hash_version, r.pii_salt])).toEqual(
      before.map((r) => [r.seq, r.hash, null, null]),
    );
    const report = await verify(up.appUrl);
    expect(report.node).toMatchObject({ ok: true, checked: 5 });
    expect(report.sql).toEqual({ problem_seq: null, problem: null });
  });

  it("refuses to erase v1 rows before the seal", async () => {
    await withClient(up.adminUrl, (c) =>
      c.query(
        `INSERT INTO install_settings (key, value) VALUES ('audit.pii_retention_hours', '1')`,
      ),
    );
    const erased = await withClient(up.adminUrl, (c) =>
      c.query(`SELECT audit_log_v1_erasable() AS ok`),
    );
    expect(erased.rows[0]?.ok).toBe(false);
  });

  it("refuses forged seals from the app role (review N1)", async () => {
    const forge = (actor: string, target: string) =>
      withClient(up.appUrl, (c) =>
        c.query(
          `INSERT INTO audit_log (actor_kind, action, target) VALUES ('${actor}', 'audit.chain.upgraded', '${target}')`,
        ),
      );
    const code = async (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
    expect(await code(forge("system", "{}"))).toBe("42501");
    expect(
      await code(forge("system", `{"throughSeq": 5, "rows": 5, "seal": "${"a".repeat(64)}"}`)),
    ).toBe("42501");
    expect(await code(forge("user", "{}"))).toBe("42501");
    // Nothing got in, so the real seal is still written below.
    expect((await rows(up.ownerUrl)).length).toBe(5);
  });

  it("is sealed once by the server: audit.chain.upgraded over the v1 rows", async () => {
    expect(await sealer(up.appUrl)).toEqual({ status: "sealed", throughSeq: 5, rows: 5 });
    expect(await sealer(up.appUrl)).toEqual({ status: "already_sealed" });
    const event = (await rows(up.ownerUrl))[5];
    expect(event).toMatchObject({ seq: 6, hash_version: 2, action: "audit.chain.upgraded" });
    expect(event?.target).toMatchObject({ throughSeq: 5, rows: 5 });
    expect((await verify(up.appUrl)).node).toMatchObject({ ok: true, checked: 6 });
  });

  it("refuses a second seal, even with the right content", async () => {
    const event = (await rows(up.ownerUrl))[5];
    const again = await withClient(up.appUrl, (c) =>
      c
        .query(
          `INSERT INTO audit_log (actor_kind, action, target) VALUES ('system', 'audit.chain.upgraded', $1)`,
          [JSON.stringify(event?.target)],
        )
        .then(
          () => "ok",
          (e: { code?: string }) => e.code,
        ),
    );
    expect(again).toBe("42501");
  });

  it("chains new rows as v2", async () => {
    await withClient(up.appUrl, (c) =>
      c.query(
        `INSERT INTO audit_log (actor_kind, action, target, ip) VALUES ('system', 'auth.sign_out', '{}', '198.51.100.4')`,
      ),
    );
    const last = (await rows(up.ownerUrl)).at(-1);
    expect(last).toMatchObject({ seq: 7, hash_version: 2, ip: "198.51.100.4" });
    expect(last?.pii_salt).toMatch(/^[0-9a-f]{64}$/);
    expect((await verify(up.appUrl)).node).toMatchObject({ ok: true, checked: 7 });
  });

  it("still verifies once the v1 rows' IP and user agent are erased", async () => {
    // As the sweep would 24 h after the seal (the trigger's own checks are tested elsewhere).
    await withClient(up.adminUrl, (c) =>
      c.query(`BEGIN; SET LOCAL session_replication_role = replica;
               UPDATE audit_log SET ip = NULL, user_agent = NULL WHERE hash_version IS NULL; COMMIT`),
    );
    const report = await verify(up.appUrl);
    expect(report.node).toMatchObject({ ok: true, checked: 7 });
    expect(report.sql).toEqual({ problem_seq: null, problem: null });
    const head = before.at(-1);
    expect((await rows(up.ownerUrl)).find((r) => r.seq === head?.seq)?.hash).toBe(head?.hash);
  });

  it("detects an edited erased v1 row through the seal, and other tampering", async () => {
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
    const both = async (tamper: string) => ({
      node: (await node(tamper)).problem,
      sql: await verifyTampered(up.adminUrl, tamper),
    });
    // Edited after erasure (or a "fake erasure" of a row that never had an IP): the seal catches it.
    for (const seq of [1, 2]) {
      expect(
        await both(`UPDATE audit_log SET target = '{"forged":true}' WHERE seq = ${seq}`),
      ).toEqual({
        node: { seq: 6, kind: "seal_mismatch" },
        sql: { problem_seq: 6, problem: "seal_mismatch" },
      });
    }
    // A second seal smuggled in past the triggers is reported as such.
    const copy = `INSERT INTO audit_log (seq, at, actor_kind, action, target, prev_hash, hash, hash_version)
      SELECT 8, now(), 'system', 'audit.chain.upgraded', a.target, h.hash, 'x', 2
      FROM audit_log a, (SELECT hash FROM audit_log WHERE seq = 7) h WHERE a.seq = 6;
      UPDATE audit_log a SET hash = audit_log_digest(audit_log_canonical(a)) WHERE seq = 8`;
    expect(await both(copy)).toEqual({
      node: { seq: 8, kind: "extra_seal" },
      sql: { problem_seq: 8, problem: "extra_seal" },
    });
    // A salt on a v1 row, a v1 row after v2 rows.
    expect(
      await both(
        `ALTER TABLE audit_log DROP CONSTRAINT audit_log_v1_uncommitted;
         UPDATE audit_log SET pii_salt = repeat('a', 64), pii_commitment = repeat('b', 64) WHERE seq = 3`,
      ),
    ).toEqual({
      node: { seq: 3, kind: "pii_mismatch" },
      sql: { problem_seq: 3, problem: "pii_mismatch" },
    });
    expect(
      await both(`ALTER TABLE audit_log DROP CONSTRAINT audit_log_v1_uncommitted;
         UPDATE audit_log SET hash_version = NULL WHERE seq = 7`),
    ).toEqual({
      node: { seq: 7, kind: "hash_mismatch" },
      sql: { problem_seq: 7, problem: "hash_mismatch" },
    });
  });
});

describe("chain v2 edge cases", () => {
  it("adds nothing to an empty log and has nothing to seal", async () => {
    const fresh = await install(DEFAULT_MIGRATIONS_FOLDER);
    expect(await sealer(fresh.appUrl)).toEqual({ status: "not_needed" });
    expect(await rows(fresh.ownerUrl)).toEqual([]);
  });

  it("upgrades a broken chain (the release isn't blocked) but never seals it", async () => {
    const broken = await install(oldMigrations);
    await seedV1(broken);
    await withClient(broken.adminUrl, (c) =>
      c.query(`BEGIN; SET LOCAL session_replication_role = replica;
               UPDATE audit_log SET target = '{"forged":true}' WHERE seq = 3; COMMIT`),
    );
    await runMigrations({ databaseUrl: broken.ownerUrl, appRole: broken.appRole });
    expect(await sealer(broken.appUrl)).toEqual({
      status: "broken",
      seq: 3,
      kind: "hash_mismatch",
    });
    expect((await rows(broken.ownerUrl)).length).toBe(5);
    // Not even with a seal computed over the broken rows: the trigger verifies them first.
    const direct = await withClient(broken.appUrl, (c) =>
      c
        .query(
          `INSERT INTO audit_log (actor_kind, action, target)
           VALUES ('system', 'audit.chain.upgraded', '{"throughSeq":5,"rows":5,"seal":"${"0".repeat(64)}"}')`,
        )
        .then(
          () => "ok",
          (e: { message?: string }) => e.message,
        ),
    );
    expect(direct).toMatch(/row 3 before the upgrade does not verify/);
    expect((await verify(broken.appUrl)).node.problem).toEqual({ seq: 3, kind: "hash_mismatch" });
  });

  it("refuses an erased v1 row without a seal", async () => {
    const unsealed = await install(oldMigrations);
    await seedV1(unsealed);
    await runMigrations({ databaseUrl: unsealed.ownerUrl, appRole: unsealed.appRole });
    await withClient(unsealed.adminUrl, (c) =>
      c.query(`BEGIN; SET LOCAL session_replication_role = replica;
               UPDATE audit_log SET ip = NULL, user_agent = NULL WHERE seq = 1; COMMIT`),
    );
    const report = await verify(unsealed.appUrl);
    expect(report.node.problem).toEqual({ seq: 1, kind: "hash_mismatch" });
    expect(report.sql).toEqual({ problem_seq: 1, problem: "hash_mismatch" });
  });
});
