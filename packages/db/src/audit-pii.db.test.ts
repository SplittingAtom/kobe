import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import {
  AUDIT_PII_RETENTION_KEY,
  AUDIT_PII_SWEEP_SEQ_KEY,
  SYSTEM_ACTOR,
  audit,
  eraseExpiredAuditPii,
  readAuditPiiRetentionHours,
  verifyAuditChain,
  type AuditChainReport,
  type AuditEvent,
} from "./audit/index.js";
import { createDb, type KobeDb } from "./client.js";
import * as schema from "./schema/index.js";
import { appendBackdatedAuditRow } from "./test-support/database.js";

/**
 * KOBE-17 audit chain v2: the IP and user agent are committed (salted) instead of hashed, erased
 * after the retention period by the app role (trigger-checked), and the chain still verifies.
 */
const app = createDb(inject("appUrl"), { max: 4 });
const owner = new pg.Pool({ connectionString: inject("ownerUrl"), max: 1 });
const admin = new pg.Pool({ connectionString: inject("adminUrl"), max: 2 });

let requester = "";
let approver = "";
let alice = "";
let teamA = "";
const holds: string[] = [];

const IP = "203.0.113.7";
const UA = "Mozilla/5.0 (KOBE-17 test)";

function signOut(actorId: string): AuditEvent {
  return {
    action: "auth.sign_out",
    actor: { kind: "user", id: actorId },
    target: {},
    request: { ip: IP, userAgent: UA },
  };
}

const record = (event: AuditEvent) => app.db.transaction((tx) => audit(tx, event));

interface PiiRow {
  seq: string;
  ip: string | null;
  user_agent: string | null;
  pii_salt: string | null;
  pii_commitment: string | null;
  hash_version: number;
  hash: string;
}

async function row(seq: number): Promise<PiiRow> {
  const { rows } = await owner.query<PiiRow>(
    `SELECT seq::text, host(ip) AS ip, user_agent, pii_salt, pii_commitment, hash_version, hash
     FROM audit_log WHERE seq = $1`,
    [seq],
  );
  const r = rows[0];
  if (!r) throw new Error(`no audit row ${seq}`);
  return r;
}

/** A row recorded `hours` ago (actor Alice unless given), at the head of the chain. */
const recordedAgo = (
  hours: number,
  input: { actorId?: string | null; teamId?: string | null } = {},
) =>
  appendBackdatedAuditRow(inject("adminUrl"), {
    hours,
    actorId: input.actorId === undefined ? alice : input.actorId,
    teamId: input.teamId ?? null,
    ip: IP,
    userAgent: UA,
  });

const erase = (seq: number, executor: pg.Pool = app.pool) =>
  executor.query(
    `UPDATE audit_log SET ip = NULL, user_agent = NULL, pii_salt = NULL WHERE seq = $1`,
    [seq],
  );

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

interface SqlCheck {
  problem_seq: string | null;
  problem: string | null;
}

/** Both verifiers (Node and the restore's SQL twin) on a tampered chain, rolled back afterwards. */
async function tampered(
  tamper: (c: pg.PoolClient) => Promise<unknown>,
): Promise<{ node: AuditChainReport; sql: SqlCheck }> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await tamper(client);
    const db = drizzle({ client, schema, casing: "snake_case" }) as unknown as KobeDb;
    const node = await verifyAuditChain(db);
    const { rows } = await client.query<SqlCheck>(
      `SELECT problem_seq::text, problem FROM audit_log_chain_problem()`,
    );
    return { node, sql: rows[0] ?? { problem_seq: null, problem: null } };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function bothOk(): Promise<void> {
  expect(await verifyAuditChain(app.db)).toMatchObject({ ok: true });
  const { rows } = await owner.query<SqlCheck>(
    `SELECT problem_seq, problem FROM audit_log_chain_problem()`,
  );
  expect(rows[0]).toEqual({ problem_seq: null, problem: null });
}

async function hold(teamId: string, userId: string | null): Promise<string> {
  const { rows } = await app.pool.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
    [teamId, userId, requester],
  );
  const id = rows[0]?.id as string;
  await app.pool.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
    id,
    approver,
  ]);
  holds.push(id);
  return id;
}

async function user(name: string, role?: "admin"): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
    id,
    name,
    `${id}@pii.test`,
  ]);
  if (role)
    await admin.query(`INSERT INTO install_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
  return id;
}

beforeAll(async () => {
  requester = await user("Requester", "admin");
  approver = await user("Approver", "admin");
  alice = await user("Alice");
  teamA = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'PII')`, [
    teamA,
    `pii-${teamA.slice(0, 8)}`,
  ]);
});

afterEach(async () => {
  // Release this file's holds so later tests (and files) can erase.
  for (const id of holds.splice(0)) {
    await app.pool.query(
      `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(), release_reason = 'done' WHERE id = $1`,
      [id, requester],
    );
    await app.pool.query(
      `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
      [id, approver],
    );
  }
  await admin.query(`DELETE FROM install_settings WHERE key = $1`, [AUDIT_PII_RETENTION_KEY]);
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await admin.end();
});

describe("chain v2: the IP and user agent are committed, not hashed", () => {
  it("salts and commits each row's IP and user agent; rows without them get neither", async () => {
    const withPii = await record(signOut(alice));
    const r = await row(withPii.seq);
    expect(r).toMatchObject({ ip: IP, user_agent: UA, hash_version: 2 });
    expect(r.pii_salt).toMatch(/^[0-9a-f]{64}$/);
    expect(r.pii_commitment).toMatch(/^[0-9a-f]{64}$/);
    // Fresh salt per row: the same values commit differently.
    const again = await row((await record(signOut(alice))).seq);
    expect(again.pii_commitment).not.toBe(r.pii_commitment);
    const none = await record({ action: "auth.sign_out", actor: SYSTEM_ACTOR, target: {} });
    expect(await row(none.seq)).toMatchObject({ pii_salt: null, pii_commitment: null });
    await bothOk();
  });

  it("refuses caller-supplied versions, salts and commitments", async () => {
    for (const [column, value] of [
      ["hash_version", "1"],
      ["pii_salt", `'${"a".repeat(64)}'`],
      ["pii_commitment", `'${"b".repeat(64)}'`],
    ] as const) {
      await expect(
        app.pool.query(
          `INSERT INTO audit_log (actor_kind, action, ${column}) VALUES ('system', 'auth.sign_out', ${value})`,
        ),
      ).rejects.toThrow(/assigned by the database/);
    }
  });
});

describe("erasure (ac-4)", () => {
  it("lets the app role erase a row past the period, and the chain still verifies", async () => {
    const seq = await recordedAgo(13);
    await bothOk();
    await erase(seq);
    const r = await row(seq);
    expect(r).toMatchObject({ ip: null, user_agent: null, pii_salt: null });
    expect(r.pii_commitment).toMatch(/^[0-9a-f]{64}$/);
    await bothOk();
  });

  it("refuses rows inside the period, for the app role and the owner alike", async () => {
    const fresh = await record(signOut(alice));
    expect(await errorCode(erase(fresh.seq))).toBe("42501");
    expect(await errorCode(erase(fresh.seq, owner))).toBe("42501");
    const elevenHours = await recordedAgo(11);
    expect(await errorCode(erase(elevenHours))).toBe("42501");
    expect((await row(elevenHours)).ip).toBe(IP);
    // A shorter period (an audited install setting) makes it erasable.
    await admin.query(`INSERT INTO install_settings (key, value) VALUES ($1, '10')`, [
      AUDIT_PII_RETENTION_KEY,
    ]);
    await erase(elevenHours);
    expect((await row(elevenHours)).ip).toBeNull();
  });

  it("allows nothing but nulling all three columns", async () => {
    const seq = await recordedAgo(20);
    for (const statement of [
      `UPDATE audit_log SET ip = '198.51.100.1' WHERE seq = ${seq}`,
      `UPDATE audit_log SET ip = NULL WHERE seq = ${seq}`,
      `UPDATE audit_log SET ip = NULL, user_agent = NULL WHERE seq = ${seq}`,
    ]) {
      expect(await errorCode(app.pool.query(statement)), statement).toBe("42501");
    }
    // Other columns: no privilege for the app role, refused by the trigger for the owner.
    for (const statement of [
      `UPDATE audit_log SET action = 'auth.sign_in.succeeded' WHERE seq = ${seq}`,
      `UPDATE audit_log SET pii_commitment = NULL WHERE seq = ${seq}`,
      `DELETE FROM audit_log WHERE seq = ${seq}`,
    ]) {
      expect(await errorCode(app.pool.query(statement)), statement).toBe("42501");
      expect(await errorCode(owner.query(statement)), statement).toBe("42501");
    }
    expect((await row(seq)).ip).toBe(IP);
  });

  it("keeps held rows: the held team's rows and every row of a held user", async () => {
    const teamRow = await recordedAgo(30, { actorId: randomUUID(), teamId: teamA });
    const aliceInstallRow = await recordedAgo(30, { actorId: alice });
    const otherRow = await recordedAgo(30, { actorId: randomUUID() });
    await hold(teamA, null);
    expect(await errorCode(erase(teamRow))).toBe("KH001");
    await hold(teamA, alice);
    // A user hold keeps the user's install-level rows (sign-ins) too.
    expect(await errorCode(erase(aliceInstallRow))).toBe("KH001");
    await erase(otherRow);
    expect((await row(teamRow)).ip).toBe(IP);
    expect((await row(otherRow)).ip).toBeNull();
  });
});

describe("eraseExpiredAuditPii (the sweep's step)", () => {
  const sweep = (page: number) => app.db.transaction((tx) => eraseExpiredAuditPii(tx, page));
  const position = async () =>
    Number(
      (
        await admin.query<{ value: string }>(`SELECT value FROM install_settings WHERE key = $1`, [
          AUDIT_PII_SWEEP_SEQ_KEY,
        ])
      ).rows[0]?.value,
    );

  it("walks from its position, erases due rows, skips held ones without re-reading them", async () => {
    const due = [await recordedAgo(15), await recordedAgo(14), await recordedAgo(13)];
    const heldRow = await recordedAgo(13, { actorId: randomUUID(), teamId: teamA });
    const young = await recordedAgo(1);
    await admin.query(
      `INSERT INTO install_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [AUDIT_PII_SWEEP_SEQ_KEY, String(due[0])],
    );
    const holdId = await hold(teamA, null);
    expect(await sweep(2)).toEqual({ rows: 2, olderThanHours: 12, more: true });
    expect(await sweep(2)).toEqual({ rows: 1, olderThanHours: 12, more: true });
    // Stops at the first row still inside the period; the held row is behind it now.
    expect(await sweep(2)).toEqual({ rows: 0, olderThanHours: 12, more: false });
    expect(await position()).toBe(young);
    for (const seq of due) expect((await row(seq)).ip).toBeNull();
    expect((await row(heldRow)).ip).toBe(IP);
    expect((await row(young)).ip).toBe(IP);
    await bothOk();

    // Releasing the hold restarts the walk (trigger), and the row it kept goes.
    holds.splice(holds.indexOf(holdId), 1);
    await app.pool.query(
      `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(), release_reason = 'done' WHERE id = $1`,
      [holdId, requester],
    );
    await app.pool.query(
      `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
      [holdId, approver],
    );
    expect(await position()).toBe(0);
    await sweep(100_000);
    expect((await row(heldRow)).ip).toBeNull();
    expect((await row(young)).ip).toBe(IP);
  });

  it("pauses after a restore until the time kobe restore set", async () => {
    const seq = await recordedAgo(40);
    await admin.query(
      `INSERT INTO install_settings (key, value) VALUES ('audit.pii_sweep_resume_at', $1)`,
      [new Date(Date.now() + 3_600_000).toISOString()],
    );
    expect(await sweep(100_000)).toEqual({ rows: 0, olderThanHours: 12, more: false });
    expect((await row(seq)).ip).toBe(IP);
    await admin.query(
      `UPDATE install_settings SET value = $1 WHERE key = 'audit.pii_sweep_resume_at'`,
      [new Date(Date.now() - 1000).toISOString()],
    );
    await admin.query(`UPDATE install_settings SET value = '0' WHERE key = $1`, [
      AUDIT_PII_SWEEP_SEQ_KEY,
    ]);
    await sweep(100_000);
    expect((await row(seq)).ip).toBeNull();
  });

  it("runs on one replica at a time", async () => {
    const other = await app.pool.connect();
    try {
      await other.query("BEGIN");
      await other.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('kobe.audit.pii_sweep', 0))`,
      );
      expect(await sweep(10)).toBeNull();
    } finally {
      await other.query("ROLLBACK");
      other.release();
    }
    expect(await sweep(10)).not.toBeNull();
  });

  it("reads the setting through the database, clamped to its bounds", async () => {
    expect(await readAuditPiiRetentionHours(app.db)).toBe(12);
    for (const [value, hours] of [
      ["48", 48],
      ["0", 1],
      ["999999", 8760],
      ["twelve", 12],
    ] as const) {
      await admin.query(
        `INSERT INTO install_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [AUDIT_PII_RETENTION_KEY, value],
      );
      expect(await readAuditPiiRetentionHours(app.db), value).toBe(hours);
    }
  });
});

describe("tampering stays detectable (Node and SQL verifiers agree)", () => {
  it("detects an IP changed while present", async () => {
    const { seq } = await record(signOut(alice));
    const report = await tampered((c) =>
      c.query(`UPDATE audit_log SET ip = '198.51.100.9' WHERE seq = $1`, [seq]),
    );
    expect(report.node.problem).toEqual({ seq, kind: "pii_mismatch" });
    expect(report.sql).toEqual({ problem_seq: String(seq), problem: "pii_mismatch" });
  });

  it("detects a value put back after erasure, and an edit next to an erasure", async () => {
    const seq = await recordedAgo(13);
    await erase(seq);
    // The CHECK constraint refuses it outright; a superuser could drop that first.
    const direct = await admin.connect();
    try {
      await direct.query("BEGIN");
      await direct.query("SET LOCAL session_replication_role = replica");
      expect(
        await errorCode(
          direct.query(`UPDATE audit_log SET user_agent = 'forged' WHERE seq = $1`, [seq]),
        ),
      ).toBe("23514");
    } finally {
      await direct.query("ROLLBACK");
      direct.release();
    }
    const restored = await tampered(async (c) => {
      await c.query(`ALTER TABLE audit_log DROP CONSTRAINT audit_log_pii_salted`);
      await c.query(`UPDATE audit_log SET user_agent = 'forged' WHERE seq = $1`, [seq]);
    });
    expect(restored.node.problem).toEqual({ seq, kind: "pii_mismatch" });
    expect(restored.sql.problem).toBe("pii_mismatch");
    const edited = await tampered((c) =>
      c.query(`UPDATE audit_log SET target = '{"forged":true}' WHERE seq = $1`, [seq]),
    );
    expect(edited.node.problem).toEqual({ seq, kind: "hash_mismatch" });
    expect(edited.sql.problem).toBe("hash_mismatch");
  });

  it("detects a commitment swapped between rows", async () => {
    const a = await record(signOut(alice));
    const b = await record(signOut(alice));
    const report = await tampered((c) =>
      c.query(
        `UPDATE audit_log x SET pii_salt = y.pii_salt, pii_commitment = y.pii_commitment
         FROM audit_log y WHERE x.seq = $1 AND y.seq = $2`,
        [a.seq, b.seq],
      ),
    );
    expect(report.node.problem).toEqual({ seq: a.seq, kind: "hash_mismatch" });
  });

  it("verifies incrementally from an anchored head", async () => {
    const { seq } = await record(signOut(alice));
    const prev = await owner.query<{ hash: string }>(`SELECT hash FROM audit_log WHERE seq = $1`, [
      seq - 1,
    ]);
    const report = await verifyAuditChain(app.db, {
      fromSeq: seq,
      expectedPrevHash: prev.rows[0]?.hash ?? "",
    });
    expect(report).toMatchObject({ ok: true });
  });
});
