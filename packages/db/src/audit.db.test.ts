import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import {
  AUDIT_GENESIS_HASH,
  AuditEventError,
  SYSTEM_ACTOR,
  audit,
  auditQuerySchema,
  listAuditEvents,
  listTeamAuditEvents,
  verifyAuditChain,
  type AuditEvent,
} from "./audit/index.js";
import { createDb, type KobeDb } from "./client.js";
import * as schema from "./schema/index.js";
import { withTeam } from "./with-team.js";

const app = createDb(inject("appUrl"), { max: 4 });
const owner = new pg.Pool({ connectionString: inject("ownerUrl"), max: 1 });
const admin = new pg.Pool({ connectionString: inject("adminUrl"), max: 1 });
afterAll(async () => {
  await app.close();
  await owner.end();
  await admin.end();
});

const user = () => ({ kind: "user" as const, id: randomUUID() });

function signOut(actorId = randomUUID()): AuditEvent {
  return { action: "auth.sign_out", actor: { kind: "user", id: actorId }, target: {} };
}

async function record(event: AuditEvent) {
  return app.db.transaction((tx) => audit(tx, event));
}

async function count(where = "true", values: unknown[] = []): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE ${where}`,
    values,
  );
  return rows[0]?.n ?? 0;
}

const pgCode = (err: unknown): string | undefined => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.cause?.code ?? e.code;
};

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return pgCode(err);
  }
  return undefined;
}

describe("audit_log is append-only in Postgres", () => {
  it("lets the app role insert and read, and denies UPDATE, DELETE and TRUNCATE", async () => {
    const { seq } = await record(signOut());
    const appPool = app.pool;
    expect(await codeOf(appPool.query(`SELECT 1 FROM audit_log WHERE seq = $1`, [seq]))).toBe(
      undefined,
    );
    for (const statement of [
      `UPDATE audit_log SET action = 'auth.sign_in.succeeded' WHERE seq = ${seq}`,
      `DELETE FROM audit_log WHERE seq = ${seq}`,
      `TRUNCATE audit_log`,
    ]) {
      expect(await codeOf(appPool.query(statement)), statement).toBe("42501");
    }
    expect(await count("seq = $1", [seq])).toBe(1);
  });

  it("refuses UPDATE, DELETE and TRUNCATE for the owner role too (trigger)", async () => {
    const { seq } = await record(signOut());
    for (const statement of [
      `UPDATE audit_log SET target = '{"x":1}' WHERE seq = ${seq}`,
      `DELETE FROM audit_log WHERE seq = ${seq}`,
      `TRUNCATE audit_log`,
    ]) {
      await expect(owner.query(statement), statement).rejects.toThrow(/append-only/);
    }
    expect(await count("seq = $1", [seq])).toBe(1);
  });

  it("assigns seq, at and hashes itself and refuses caller-supplied ones", async () => {
    for (const column of ["seq", "hash", "prev_hash"]) {
      const value = column === "seq" ? "999999" : "'f00'";
      await expect(
        app.pool.query(
          `INSERT INTO audit_log (actor_kind, action, ${column}) VALUES ('system', 'auth.sign_out', ${value})`,
        ),
      ).rejects.toThrow(/assigned by the database/);
    }
    const before = new Date(Date.now() - 1000);
    const a = await record(signOut());
    const b = await record(signOut());
    expect(b.seq).toBe(a.seq + 1);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.at.getTime()).toBeGreaterThanOrEqual(a.at.getTime());
    expect(a.at.getTime()).toBeGreaterThan(before.getTime());
    const { rows } = await owner.query<{ prev_hash: string }>(
      `SELECT prev_hash FROM audit_log WHERE seq = $1`,
      [b.seq],
    );
    expect(rows[0]?.prev_hash).toBe(a.hash);
  });
});

describe("audit() inside the action's transaction", () => {
  it("rolls back with the action: no audit row for a failed action", async () => {
    const actorId = randomUUID();
    const before = await count("actor_id = $1", [actorId]);
    await expect(
      app.db.transaction(async (tx) => {
        await audit(tx, signOut(actorId));
        throw new Error("the action failed");
      }),
    ).rejects.toThrow("the action failed");
    expect(await count("actor_id = $1", [actorId])).toBe(before);
  });

  it("fails the action when the event is invalid (allowlist, scope, actor)", async () => {
    const teamId = randomUUID();
    const bad: unknown[] = [
      // A field outside the allowlist (e.g. a secret) is rejected, not stored.
      { action: "auth.sign_out", actor: user(), target: { password: "hunter2" } },
      {
        action: "identity.invitation.created",
        actor: user(),
        target: { invitationId: randomUUID(), email: "a@example.com", token: "abc" },
      },
      { action: "auth.unknown_thing", actor: user(), target: {} },
      // Team events need a team; install events refuse one.
      {
        action: "identity.member.removed",
        actor: user(),
        target: { userId: randomUUID(), role: "member" },
      },
      { action: "auth.sign_out", actor: user(), teamId, target: {} },
      { action: "auth.sign_out", actor: { kind: "system", id: randomUUID() }, target: {} },
      { action: "auth.sign_out", actor: { kind: "user", id: "not-a-uuid" }, target: {} },
    ];
    for (const event of bad) {
      await expect(
        app.db.transaction((tx) => audit(tx, event as AuditEvent)),
        JSON.stringify(event),
      ).rejects.toBeInstanceOf(AuditEventError);
    }
  });

  it("drops invalid request metadata instead of failing", async () => {
    const actorId = randomUUID();
    await record({
      ...signOut(actorId),
      request: { ip: "not an ip", userAgent: `x\u0000y${"z".repeat(400)}` },
    });
    const { rows } = await owner.query<{ ip: string | null; user_agent: string }>(
      `SELECT host(ip) AS ip, user_agent FROM audit_log WHERE actor_id = $1`,
      [actorId],
    );
    expect(rows[0]?.ip).toBeNull();
    expect(rows[0]?.user_agent.length).toBe(256);
    expect(rows[0]?.user_agent.startsWith("x y")).toBe(true);
  });

  it("inside withTeam, refuses an event for another team", async () => {
    const mine = randomUUID();
    const other = randomUUID();
    const event = (teamId: string): AuditEvent => ({
      action: "identity.member.removed",
      actor: user(),
      teamId,
      target: { userId: randomUUID(), role: "member" },
    });
    await withTeam(app.db, mine, (tx) => audit(tx, event(mine)));
    const code = await codeOf(withTeam(app.db, mine, (tx) => audit(tx, event(other))));
    expect(code).toBe("42501");
  });

  it("keeps seq gapless and the chain intact under concurrent appends and rollbacks", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, (_, i) =>
        app.db.transaction(async (tx) => {
          await audit(tx, signOut());
          if (i % 4 === 0) throw new Error("rolled back");
        }),
      ),
    );
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(6);
    const { rows } = await owner.query<{ n: number; max: number }>(
      `SELECT count(*)::int AS n, max(seq)::int AS max FROM audit_log`,
    );
    expect(rows[0]?.n).toBe(rows[0]?.max);
    const report = await verifyAuditChain(app.db, { batchSize: 7 });
    expect(report).toMatchObject({ ok: true, checked: rows[0]?.n });
  });
});

describe("hash chain verification", () => {
  /** Tampers as a superuser inside a transaction that is always rolled back. */
  async function tampered(
    tamper: (client: pg.PoolClient) => Promise<unknown>,
  ): Promise<Awaited<ReturnType<typeof verifyAuditChain>>> {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica"); // skips user triggers
      await tamper(client);
      const db = drizzle({ client, schema, casing: "snake_case" }) as unknown as KobeDb;
      return await verifyAuditChain(db);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  it("verifies an untouched chain from genesis and returns its head", async () => {
    await record(signOut());
    const report = await verifyAuditChain(app.db);
    expect(report.ok).toBe(true);
    const { rows } = await owner.query<{ seq: string; hash: string; first_prev: string }>(
      `SELECT a.seq::text AS seq, a.hash, (SELECT prev_hash FROM audit_log WHERE seq = 1) AS first_prev
       FROM audit_log a ORDER BY a.seq DESC LIMIT 1`,
    );
    expect(report.head).toEqual({ seq: Number(rows[0]?.seq), hash: rows[0]?.hash });
    expect(rows[0]?.first_prev).toBe(AUDIT_GENESIS_HASH);
  });

  it("verifies incrementally from an anchored head", async () => {
    const anchor = await verifyAuditChain(app.db);
    const next = await record(signOut());
    const report = await verifyAuditChain(app.db, {
      fromSeq: (anchor.head?.seq ?? 0) + 1,
      expectedPrevHash: anchor.head?.hash ?? "",
    });
    expect(report).toEqual({ ok: true, checked: 1, head: { seq: next.seq, hash: next.hash } });
  });

  it("detects an edited row", async () => {
    const { seq } = await record(signOut());
    const report = await tampered((c) =>
      c.query(`UPDATE audit_log SET target = '{"forged":true}' WHERE seq = $1`, [seq]),
    );
    expect(report.problem).toEqual({ seq, kind: "hash_mismatch" });
  });

  it("detects a deleted row", async () => {
    const { seq } = await record(signOut());
    await record(signOut());
    const report = await tampered((c) => c.query(`DELETE FROM audit_log WHERE seq = $1`, [seq]));
    expect(report.problem).toEqual({ seq: seq + 1, kind: "gap" });
  });

  it("detects a re-chained deletion (seq renumbered)", async () => {
    const { seq } = await record(signOut());
    await record(signOut());
    const report = await tampered(async (c) => {
      await c.query(`DELETE FROM audit_log WHERE seq = $1`, [seq]);
      await c.query(`UPDATE audit_log SET seq = $1 WHERE seq = $2`, [seq, seq + 1]);
    });
    expect(report.problem).toEqual({ seq, kind: "prev_hash_mismatch" });
  });
});

describe("reading the audit log", () => {
  const teamA = randomUUID();
  const teamB = randomUUID();
  const actor = user();

  async function seed() {
    const removed = (teamId: string): AuditEvent => ({
      action: "identity.member.removed",
      actor,
      teamId,
      target: { userId: randomUUID(), role: "builder" },
    });
    for (let i = 0; i < 5; i++) await withTeam(app.db, teamA, (tx) => audit(tx, removed(teamA)));
    for (let i = 0; i < 3; i++) await withTeam(app.db, teamB, (tx) => audit(tx, removed(teamB)));
    await record({ ...signOut(actor.id ?? undefined), request: { ip: "203.0.113.9" } });
  }

  it("shows a team only its own events, newest first, with keyset pages", async () => {
    await seed();
    const first = await listTeamAuditEvents(app.db, teamA, { limit: 3 });
    expect(first.events).toHaveLength(3);
    expect(first.events.every((e) => e.teamId === teamA)).toBe(true);
    expect(first.nextCursor).toBe(first.events.at(-1)?.seq);
    const second = await listTeamAuditEvents(app.db, teamA, {
      limit: 3,
      before: first.nextCursor ?? 0,
    });
    expect(second.events).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const seqs = [...first.events, ...second.events].map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => y - x));

    // A teamId in the query can't widen the view.
    const sneaky = await listTeamAuditEvents(app.db, teamA, { teamId: teamB, limit: 50 });
    expect(sneaky.events.every((e) => e.teamId === teamA)).toBe(true);
    expect(sneaky.events).toHaveLength(5);
  });

  it("hides client IPs and user agents in the team view", async () => {
    const page = await listTeamAuditEvents(app.db, teamA, { limit: 50 });
    expect(page.events.every((e) => e.ip === null && e.userAgent === null)).toBe(true);
  });

  it("filters the install log by action, category, actor, team and time; pages forwards", async () => {
    const byTeam = await listAuditEvents(app.db, { teamId: teamB, limit: 50 });
    expect(byTeam.events).toHaveLength(3);
    const byActor = await listAuditEvents(app.db, { actorId: actor.id ?? "", limit: 50 });
    expect(byActor.events).toHaveLength(9);
    const signOuts = await listAuditEvents(app.db, {
      actorId: actor.id ?? "",
      action: "auth.sign_out",
    });
    expect(signOuts.events).toHaveLength(1);
    expect(signOuts.events[0]?.ip).toBe("203.0.113.9");
    const identity = await listAuditEvents(app.db, {
      actorId: actor.id ?? "",
      category: "identity",
      limit: 50,
    });
    expect(identity.events).toHaveLength(8);
    const future = await listAuditEvents(app.db, { since: "2999-01-01T00:00:00Z" });
    expect(future.events).toEqual([]);
    const forwards = await listAuditEvents(app.db, { teamId: teamB, after: 0, limit: 2 });
    expect(forwards.events.map((e) => e.seq)).toEqual(
      [...forwards.events.map((e) => e.seq)].sort((x, y) => x - y),
    );
    expect(forwards.nextCursor).toBe(forwards.events[1]?.seq);
  });

  it("validates query input", () => {
    expect(auditQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(auditQuerySchema.safeParse({ action: "made.up" }).success).toBe(false);
    expect(auditQuerySchema.safeParse({ before: "1", after: "2" }).success).toBe(false);
    expect(auditQuerySchema.safeParse({ extra: "x" }).success).toBe(false);
    expect(auditQuerySchema.parse({ limit: "20", category: "auth" })).toEqual({
      limit: 20,
      category: "auth",
    });
  });

  it("reads system events with no actor", async () => {
    await record({
      action: "platform.isolation.changed",
      actor: SYSTEM_ACTOR,
      target: { from: "verified", to: "missing", replica: "kobe-server-0" },
    });
    const page = await listAuditEvents(app.db, { action: "platform.isolation.changed" });
    expect(page.events[0]?.actor).toEqual({ kind: "system", id: null, name: null, email: null });
  });
});
