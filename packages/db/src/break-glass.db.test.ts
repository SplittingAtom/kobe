import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BreakGlassDenied, readWithBreakGlass, type BreakGlassRead } from "./break-glass/read.js";
import { createDb } from "./client.js";

/**
 * KOBE-16 break-glass in the data layer: the guard trigger (two-person rule, roles, time box,
 * transitions) and readWithBreakGlass (grant verified per read, scope, audit of every read).
 */
const app = createDb(inject("appUrl"), { max: 4 });
const appClient = new pg.Client({ connectionString: inject("appUrl") });
// Superuser: fixtures under FORCE RLS, and moving a window into the past (triggers bypassed).
const admin = new pg.Client({ connectionString: inject("adminUrl") });

let requester = "";
let approver = "";
let alice = ""; // member of team A
let bob = ""; // member of team A
let mallory = ""; // plain user
let teamA = "";
let teamB = "";
let aliceThread = "";
let bobThread = "";
let otherTeamThread = "";

async function user(name: string, role?: "admin"): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
    id,
    name,
    `${id}@bg.test`,
  ]);
  if (role)
    await admin.query(`INSERT INTO install_roles (user_id, role) VALUES ($1, $2)`, [id, role]);
  return id;
}

async function team(): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    id,
    `bg-${id.slice(0, 8)}`,
  ]);
  return id;
}

async function thread(teamId: string, owner: string, entries = 0): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO threads (team_id, id, owner_user_id, title) VALUES ($1, $2, $3, 't')`,
    [teamId, id, owner],
  );
  let parent: string | null = null;
  for (let i = 1; i <= entries; i++) {
    await admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, $3, $4, 'message', $5)`,
      [
        teamId,
        id,
        `e${i}`,
        parent,
        JSON.stringify({ message: { role: "user", content: `m${i}` } }),
      ],
    );
    parent = `e${i}`;
  }
  return id;
}

interface GrantInput {
  teamId?: string;
  adminId?: string;
  userId?: string | null;
  threadId?: string | null;
  duration?: number;
  legalHold?: boolean;
}

async function request(input: GrantInput = {}): Promise<string> {
  const { rows } = await appClient.query<{ id: string }>(
    `INSERT INTO break_glass_grants (team_id, admin_id, user_id, thread_id, reason, duration_minutes, legal_hold)
     VALUES ($1, $2, $3, $4, 'incident 42', $5, $6) RETURNING id`,
    [
      input.teamId ?? teamA,
      input.adminId ?? requester,
      input.userId ?? null,
      input.threadId ?? null,
      input.duration ?? 60,
      input.legalHold ?? false,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("insert returned no row");
  return id;
}

const approve = (id: string, by = approver) =>
  appClient.query(
    `UPDATE break_glass_grants SET status = 'approved', approver_id = $2 WHERE id = $1 AND status = 'pending'`,
    [id, by],
  );

async function approved(input: GrantInput = {}): Promise<string> {
  const id = await request(input);
  await approve(id);
  return id;
}

async function grantRow(id: string) {
  const { rows } = await admin.query(`SELECT * FROM break_glass_grants WHERE id = $1`, [id]);
  return rows[0];
}

/** Moves a grant's window into the past, as time would (superuser, triggers bypassed). */
async function backdate(id: string): Promise<void> {
  await admin.query(`SET session_replication_role = replica`);
  await admin.query(
    `UPDATE break_glass_grants SET starts_at = now() - interval '2 hours', expires_at = now() - interval '1 hour',
       request_expires_at = now() - interval '1 hour' WHERE id = $1`,
    [id],
  );
  await admin.query(`SET session_replication_role = origin`);
}

async function reads(
  grantId: string,
): Promise<{ action: string; team_id: string; target: Record<string, unknown> }[]> {
  const { rows } = await admin.query(
    `SELECT action, team_id, target FROM audit_log WHERE target->>'grantId' = $1 ORDER BY seq`,
    [grantId],
  );
  return rows;
}

const errorCode = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof BreakGlassDenied) return err.code;
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
};

const read = (grantId: string, r: BreakGlassRead, adminId = requester) =>
  readWithBreakGlass(app.db, { grantId, adminId, request: { ip: "203.0.113.9" } }, r);

beforeAll(async () => {
  await appClient.connect();
  await admin.connect();
  requester = await user("Requester", "admin");
  approver = await user("Approver", "admin");
  alice = await user("Alice");
  bob = await user("Bob");
  mallory = await user("Mallory");
  teamA = await team();
  teamB = await team();
  aliceThread = await thread(teamA, alice, 3);
  bobThread = await thread(teamA, bob, 1);
  otherTeamThread = await thread(teamB, alice, 1);
});

afterAll(async () => {
  await app.close();
  await appClient.end();
  await admin.end();
});

describe("break_glass_grants guard trigger", () => {
  it("lets an install admin request; the database stamps the request window", async () => {
    const row = await grantRow(await request());
    expect(row.status).toBe("pending");
    expect(row.request_expires_at.getTime() - row.requested_at.getTime()).toBe(24 * 3600_000);
  });

  it("refuses requests from plain users and requests that skip approval", async () => {
    expect(await errorCode(request({ adminId: mallory }))).toBe("42501");
    await expect(
      appClient.query(
        `INSERT INTO break_glass_grants (team_id, admin_id, reason, status, approver_id)
         VALUES ($1, $2, 'x', 'approved', $3)`,
        [teamA, requester, approver],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("refuses self-approval while a second install admin exists", async () => {
    const id = await request();
    expect(await errorCode(approve(id, requester))).toBe("42501");
    expect((await grantRow(id)).status).toBe("pending");
  });

  it("approval by a second admin sets the window from the requested duration", async () => {
    const id = await request({ duration: 90 });
    await approve(id);
    const row = await grantRow(id);
    expect(row).toMatchObject({ status: "approved", approver_id: approver, self_approved: false });
    expect(row.expires_at.getTime() - row.starts_at.getTime()).toBe(90 * 60_000);
  });

  it("refuses approval by a plain user, by the subject, and after the request lapsed", async () => {
    const id = await request();
    expect(await errorCode(approve(id, mallory))).toBe("42501");
    const subjectAdmin = await user("Subject admin", "admin");
    const aboutSubject = await request({ userId: subjectAdmin });
    expect(await errorCode(approve(aboutSubject, subjectAdmin))).toBe("42501");
    const lapsed = await request();
    await backdate(lapsed);
    expect(await errorCode(approve(lapsed))).toBe("55000");
  });

  it("never changes what was asked for, and allows only forward transitions", async () => {
    const id = await approved();
    for (const [statement, values] of [
      [`UPDATE break_glass_grants SET reason = 'other' WHERE id = $1`, [id]],
      [`UPDATE break_glass_grants SET team_id = $2 WHERE id = $1`, [id, teamB]],
      [`UPDATE break_glass_grants SET status = 'pending' WHERE id = $1`, [id]],
      [
        `UPDATE break_glass_grants SET expires_at = expires_at + interval '1 hour' WHERE id = $1`,
        [id],
      ],
      // Expiry only once the window is over.
      [`UPDATE break_glass_grants SET status = 'expired' WHERE id = $1`, [id]],
    ] as const) {
      expect(await errorCode(appClient.query(statement, [...values])), statement).toBe("55000");
    }
    await appClient.query(
      `UPDATE break_glass_grants SET status = 'revoked', decided_by = $2 WHERE id = $1`,
      [id, requester],
    );
    expect(
      await errorCode(
        appClient.query(
          `UPDATE break_glass_grants SET status = 'approved', approver_id = $2 WHERE id = $1`,
          [id, approver],
        ),
      ),
    ).toBe("55000");
  });

  it("refuses denial by the requester (they withdraw instead) and by non-admins", async () => {
    const id = await request();
    const deny = (by: string) =>
      appClient.query(
        `UPDATE break_glass_grants SET status = 'denied', decided_by = $2 WHERE id = $1`,
        [id, by],
      );
    expect(await errorCode(deny(requester))).toBe("42501");
    expect(await errorCode(deny(mallory))).toBe("42501");
    await deny(approver);
    expect((await grantRow(id)).status).toBe("denied");
  });

  it("can't be deleted by the app role", async () => {
    const id = await request();
    expect(
      await errorCode(appClient.query(`DELETE FROM break_glass_grants WHERE id = $1`, [id])),
    ).toBe("42501");
  });

  it("counts only active admins as a second approver (D10: when one exists)", async () => {
    const { rows } = await admin.query<{ user_id: string }>(
      `UPDATE users u SET deactivated_at = now() FROM install_roles r
       WHERE r.user_id = u.id AND u.id <> $1 AND u.deactivated_at IS NULL RETURNING u.id AS user_id`,
      [requester],
    );
    try {
      const id = await request();
      await approve(id, requester);
      expect(await grantRow(id)).toMatchObject({ status: "approved", self_approved: true });
    } finally {
      await admin.query(`UPDATE users SET deactivated_at = NULL WHERE id = ANY($1)`, [
        rows.map((r) => r.user_id),
      ]);
    }
  });

  it("refuses approval by a deactivated or demoted admin", async () => {
    const former = await user("Former admin", "admin");
    const id = await request();
    await admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [former]);
    expect(await errorCode(approve(id, former))).toBe("42501");
    await admin.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [former]);
    await admin.query(`DELETE FROM install_roles WHERE user_id = $1`, [former]);
    expect(await errorCode(approve(id, former))).toBe("42501");
    expect((await grantRow(id)).status).toBe("pending");
  });

  it("serializes a self-approval behind a concurrent promotion of a second admin", async () => {
    // Only the requester is an active admin; a promotion is in flight when they self-approve.
    const { rows } = await admin.query<{ user_id: string; role: string }>(
      `DELETE FROM install_roles WHERE user_id <> $1 RETURNING user_id, role::text`,
      [requester],
    );
    const promoter = new pg.Client({ connectionString: inject("appUrl") });
    await promoter.connect();
    try {
      const id = await request();
      await promoter.query("BEGIN");
      await promoter.query(`INSERT INTO install_roles (user_id, role) VALUES ($1, 'admin')`, [
        mallory,
      ]);
      const selfApproval = errorCode(approve(id, requester));
      await new Promise((r) => setTimeout(r, 200));
      await promoter.query("COMMIT");
      // The approval waited for the promotion and then saw a second active admin.
      expect(await selfApproval).toBe("42501");
      expect((await grantRow(id)).status).toBe("pending");
    } finally {
      await promoter.end();
      await admin.query(`DELETE FROM install_roles WHERE user_id = $1`, [mallory]);
      for (const r of rows) {
        await admin.query(`INSERT INTO install_roles (user_id, role) VALUES ($1, $2)`, [
          r.user_id,
          r.role,
        ]);
      }
    }
  });

  it("refuses denial and revocation by the subject", async () => {
    const subjectAdmin = await user("Subject admin 2", "admin");
    const id = await approved({ userId: subjectAdmin });
    expect(
      await errorCode(
        appClient.query(
          `UPDATE break_glass_grants SET status = 'revoked', decided_by = $2 WHERE id = $1`,
          [id, subjectAdmin],
        ),
      ),
    ).toBe("42501");
  });

  it("lets a single-admin install self-approve, flagged (D10)", async () => {
    // Every other install role is removed for the duration of this test.
    const { rows } = await admin.query<{ user_id: string; role: string }>(
      `DELETE FROM install_roles WHERE user_id <> $1 RETURNING user_id, role::text`,
      [requester],
    );
    try {
      const id = await request();
      await approve(id, requester);
      expect(await grantRow(id)).toMatchObject({
        status: "approved",
        approver_id: requester,
        self_approved: true,
      });
    } finally {
      for (const r of rows) {
        await admin.query(`INSERT INTO install_roles (user_id, role) VALUES ($1, $2)`, [
          r.user_id,
          r.role,
        ]);
      }
    }
  });
});

describe("readWithBreakGlass", () => {
  it("reads the whole team's threads under a team grant and audits the read under the team", async () => {
    const id = await approved();
    const result = await read(id, { kind: "threads", limit: 50 });
    if (result.kind !== "threads") throw new Error("kind");
    expect(result.threads.map((t) => t.id).sort()).toEqual([aliceThread, bobThread].sort());
    expect(result.grant).toMatchObject({ teamId: teamA, scope: "team" });
    expect(await reads(id)).toEqual([
      {
        action: "governance.break_glass.read",
        team_id: teamA,
        target: { grantId: id, object: "thread_list" },
      },
    ]);
    const { rows } = await admin.query(
      `SELECT actor_id, host(ip) AS ip FROM audit_log WHERE target->>'grantId' = $1`,
      [id],
    );
    expect(rows).toEqual([{ actor_id: requester, ip: "203.0.113.9" }]);
  });

  it("pages the thread list with a keyset cursor", async () => {
    const id = await approved();
    const first = await read(id, { kind: "threads", limit: 1 });
    if (first.kind !== "threads" || !first.next) throw new Error("expected a next page");
    const second = await read(id, { kind: "threads", limit: 1, cursor: first.next });
    if (second.kind !== "threads") throw new Error("kind");
    expect([...first.threads, ...second.threads].map((t) => t.id).sort()).toEqual(
      [aliceThread, bobThread].sort(),
    );
    expect(second.next).toBeNull();
  });

  it("reads entries of a thread in scope", async () => {
    const id = await approved();
    const result = await read(id, {
      kind: "entries",
      threadId: aliceThread,
      afterSeq: 0,
      limit: 2,
    });
    if (result.kind !== "entries") throw new Error("kind");
    expect(result.entries.map((e) => e.entryId)).toEqual(["e1", "e2"]);
    expect(result.entries[0]?.payload).toEqual({ message: { role: "user", content: "m1" } });
    expect(result.nextAfter).toBe(2);
    expect((await reads(id)).at(-1)?.target).toEqual({
      grantId: id,
      object: "thread_entries",
      threadId: aliceThread,
    });
  });

  it("narrows a user grant to the subject's threads; others are not found and not audited", async () => {
    const id = await approved({ userId: alice });
    const list = await read(id, { kind: "threads", limit: 50 });
    if (list.kind !== "threads") throw new Error("kind");
    expect(list.threads.map((t) => t.id)).toEqual([aliceThread]);
    expect(await errorCode(read(id, { kind: "thread", threadId: bobThread }))).toBe("not_found");
    expect(
      await errorCode(read(id, { kind: "entries", threadId: bobThread, afterSeq: 0, limit: 10 })),
    ).toBe("not_found");
    expect(
      (await reads(id)).filter((r) => r.action === "governance.break_glass.read"),
    ).toHaveLength(1);
  });

  it("narrows a thread grant to that thread", async () => {
    const id = await approved({ threadId: bobThread });
    const list = await read(id, { kind: "threads", limit: 50 });
    if (list.kind !== "threads") throw new Error("kind");
    expect(list.threads.map((t) => t.id)).toEqual([bobThread]);
    expect(await errorCode(read(id, { kind: "thread", threadId: aliceThread }))).toBe("not_found");
  });

  it("never reaches another team's threads, even by id", async () => {
    const id = await approved();
    expect(await errorCode(read(id, { kind: "thread", threadId: otherTeamThread }))).toBe(
      "not_found",
    );
    expect(
      await errorCode(
        read(id, { kind: "entries", threadId: otherTeamThread, afterSeq: 0, limit: 5 }),
      ),
    ).toBe("not_found");
  });

  it("refuses pending, denied, revoked and expired grants", async () => {
    const pending = await request();
    expect(await errorCode(read(pending, { kind: "threads", limit: 5 }))).toBe("grant_not_active");
    const expired = await approved();
    await backdate(expired);
    expect(await errorCode(read(expired, { kind: "threads", limit: 5 }))).toBe("grant_not_active");
    expect(await reads(pending)).toEqual([]);
    expect(await reads(expired)).toEqual([]);
  });

  it("re-checks on every read: a revocation applies to the next read", async () => {
    const id = await approved();
    await read(id, { kind: "threads", limit: 5 });
    await appClient.query(
      `UPDATE break_glass_grants SET status = 'revoked', decided_by = $2 WHERE id = $1`,
      [id, approver],
    );
    expect(await errorCode(read(id, { kind: "threads", limit: 5 }))).toBe("grant_not_active");
  });

  it("is usable only by the requester, and only while they are an install admin", async () => {
    const id = await approved();
    expect(await errorCode(read(id, { kind: "threads", limit: 5 }, approver))).toBe(
      "grant_not_found",
    );
    expect(await errorCode(read(randomUUID(), { kind: "threads", limit: 5 }))).toBe(
      "grant_not_found",
    );
    await admin.query(`DELETE FROM install_roles WHERE user_id = $1`, [requester]);
    try {
      expect(await errorCode(read(id, { kind: "threads", limit: 5 }))).toBe("grant_not_active");
    } finally {
      await admin.query(`INSERT INTO install_roles (user_id, role) VALUES ($1, 'admin')`, [
        requester,
      ]);
    }
  });

  it("makes a concurrent revocation wait for an in-flight read, then refuses the next one", async () => {
    const id = await approved();
    // Hold the read's grant lock open by holding the audit chain lock elsewhere: the read takes
    // its FOR SHARE lock, then waits for the chain lock while the revocation queues behind it.
    const blocker = new pg.Client({ connectionString: inject("appUrl") });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT pg_advisory_xact_lock(hashtextextended('kobe.audit_log', 0))`);
      const inFlight = read(id, { kind: "threads", limit: 5 });
      await new Promise((r) => setTimeout(r, 200));
      const revoke = appClient.query(
        `UPDATE break_glass_grants SET status = 'revoked', decided_by = $2 WHERE id = $1 RETURNING status`,
        [id, approver],
      );
      await new Promise((r) => setTimeout(r, 200));
      await blocker.query("COMMIT");
      const [result] = await Promise.all([inFlight, revoke]);
      expect(result.kind).toBe("threads");
    } finally {
      await blocker.end();
    }
    expect((await grantRow(id)).status).toBe("revoked");
    expect(await errorCode(read(id, { kind: "threads", limit: 5 }))).toBe("grant_not_active");
    expect(await reads(id)).toHaveLength(1);
  });

  it("leaves the thread id out of a legal hold's read events", async () => {
    const id = await approved({ userId: alice, legalHold: true });
    await read(id, { kind: "thread", threadId: aliceThread });
    expect((await reads(id)).map((r) => r.target)).toEqual([{ grantId: id, object: "thread" }]);
  });

  it("returns nothing and leaves no audit row when the audit write fails", async () => {
    const id = await approved();
    const blocker = new pg.Client({ connectionString: inject("appUrl") });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT pg_advisory_xact_lock(hashtextextended('kobe.audit_log', 0))`);
      // The read's own lock timeout (5 s) expires on the audit chain lock.
      await expect(read(id, { kind: "threads", limit: 5 })).rejects.toMatchObject({
        name: "AuditBusyError",
      });
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
    expect(await reads(id)).toEqual([]);
  });

  it("a read held up past expiry returns nothing (RLS checks per statement); the next is refused", async () => {
    const id = await approved();
    await admin.query(`SET session_replication_role = replica`);
    await admin.query(
      `UPDATE break_glass_grants SET expires_at = now() + interval '1500 milliseconds' WHERE id = $1`,
      [id],
    );
    await admin.query(`SET session_replication_role = origin`);
    const blocker = new pg.Client({ connectionString: inject("appUrl") });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT pg_advisory_xact_lock(hashtextextended('kobe.audit_log', 0))`);
      const inFlight = read(id, { kind: "threads", limit: 5 });
      await new Promise((r) => setTimeout(r, 2000));
      await blocker.query("COMMIT");
      const result = await inFlight;
      if (result.kind !== "threads") throw new Error("kind");
      // It passed the grant check before expiry, but the read statement runs after it.
      expect(result.threads).toEqual([]);
    } finally {
      await blocker.end();
    }
    expect(await errorCode(read(id, { kind: "threads", limit: 5 }))).toBe("grant_not_active");
  });

  it("refuses malformed reads before touching the database", async () => {
    const id = await approved();
    await expect(read(id, { kind: "threads", limit: 1000 })).rejects.toThrow();
    expect(await errorCode(read("not-a-uuid", { kind: "threads", limit: 5 }))).toBe(
      "grant_not_found",
    );
  });
});
