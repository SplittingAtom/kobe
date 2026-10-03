import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./client.js";
import {
  LEGAL_HOLD_SQLSTATE,
  isLegalHoldViolation,
  isUnderLegalHold,
  legalHoldsForTeam,
  lockLegalHolds,
} from "./legal-hold/index.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-17 legal hold in the data layer: the guard trigger (two-person rule for placing and
 * releasing, transitions), the consumer API for purge jobs, the delete guards on threads and
 * thread entries (ac-1), and the ordering of approvals against purges.
 */
const app = createDb(inject("appUrl"), { max: 4 });
const appClient = new pg.Client({ connectionString: inject("appUrl") });
// Superuser: fixtures under FORCE RLS.
const admin = new pg.Client({ connectionString: inject("adminUrl") });

let requester = "";
let approver = "";
let alice = ""; // member of team A, held user
let bob = ""; // member of team A
let teamA = "";
let teamB = "";

async function user(name: string, role?: "admin"): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
    id,
    name,
    `${id}@lh.test`,
  ]);
  if (role) {
    await admin.query(`INSERT INTO install_roles (user_id, role) VALUES ($1, $2)`, [id, role]);
  }
  return id;
}

async function team(): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    id,
    `lh-${id.slice(0, 8)}`,
  ]);
  return id;
}

async function thread(teamId: string, owner: string, entries = 2): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO threads (team_id, id, owner_user_id, title) VALUES ($1, $2, $3, 't')`,
    [teamId, id, owner],
  );
  let parent: string | null = null;
  for (let i = 1; i <= entries; i++) {
    await admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, $3, $4, 'message', '{}')`,
      [teamId, id, `e${i}`, parent],
    );
    parent = `e${i}`;
  }
  return id;
}

async function request(
  input: { teamId?: string; userId?: string | null; by?: string } = {},
): Promise<string> {
  const { rows } = await appClient.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter 7', $3)
     RETURNING id`,
    [input.teamId ?? teamA, input.userId ?? null, input.by ?? requester],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("insert returned no row");
  return id;
}

const approve = (id: string, by = approver) =>
  appClient.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
    id,
    by,
  ]);

const askRelease = (id: string, by = requester) =>
  appClient.query(
    `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(),
       release_reason = 'matter closed' WHERE id = $1`,
    [id, by],
  );

const release = (id: string, by = approver) =>
  appClient.query(`UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`, [
    id,
    by,
  ]);

async function active(input: { teamId?: string; userId?: string | null } = {}): Promise<string> {
  const id = await request(input);
  await approve(id);
  return id;
}

async function releaseHold(id: string): Promise<void> {
  await askRelease(id);
  await release(id);
}

async function holdRow(id: string) {
  const { rows } = await admin.query(`SELECT * FROM legal_holds WHERE id = $1`, [id]);
  return rows[0];
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

/** Runs `fn` with every install admin but `keep` removed, then restores them. */
async function asSoleAdmin(keep: string, fn: () => Promise<void>): Promise<void> {
  const { rows } = await admin.query<{ user_id: string; role: string }>(
    `DELETE FROM install_roles WHERE user_id <> $1 RETURNING user_id, role::text`,
    [keep],
  );
  try {
    await fn();
  } finally {
    for (const r of rows) {
      await admin.query(`INSERT INTO install_roles (user_id, role) VALUES ($1, $2)`, [
        r.user_id,
        r.role,
      ]);
    }
  }
}

beforeAll(async () => {
  await appClient.connect();
  await admin.connect();
  requester = await user("Requester", "admin");
  approver = await user("Approver", "admin");
  alice = await user("Alice");
  bob = await user("Bob");
  teamA = await team();
  teamB = await team();
});

afterAll(async () => {
  await app.close();
  await appClient.end();
  await admin.end();
});

describe("legal_holds_guard: the two-person rule in Postgres (ac-2)", () => {
  it("starts every hold as a pending request from an active install admin", async () => {
    const id = await request({ userId: alice });
    expect(await holdRow(id)).toMatchObject({ status: "pending", approved_by: null });
    expect(
      await errorCode(
        appClient.query(
          `INSERT INTO legal_holds (team_id, reason, placed_by, status, approved_by)
           VALUES ($1, 'x', $2, 'active', $3)`,
          [teamA, requester, approver],
        ),
      ),
    ).toBe("55000");
    expect(await errorCode(request({ by: alice }))).toBe("42501");
    // The subject of a hold is never its requester.
    expect(await errorCode(request({ userId: requester }))).toBe("23514");
  });

  it("is placed by a second install admin, never the requester while another admin exists", async () => {
    const id = await request();
    expect(await errorCode(approve(id, requester))).toBe("42501");
    expect((await holdRow(id)).status).toBe("pending");
    await approve(id);
    expect(await holdRow(id)).toMatchObject({
      status: "active",
      approved_by: approver,
      self_approved: false,
    });
    expect((await holdRow(id)).approved_at).not.toBeNull();
    await releaseHold(id);
  });

  it("refuses approval by a plain user or by the held user", async () => {
    const id = await request({ userId: alice });
    expect(await errorCode(approve(id, bob))).toBe("42501");
    const subjectAdmin = await user("Subject admin", "admin");
    const onAdmin = await request({ userId: subjectAdmin });
    expect(await errorCode(approve(onAdmin, subjectAdmin))).toBe("42501");
    expect((await holdRow(onAdmin)).status).toBe("pending");
  });

  it("lets a single-admin install self-approve placing and releasing, flagged (D10)", async () => {
    await asSoleAdmin(requester, async () => {
      const id = await request();
      await approve(id, requester);
      expect(await holdRow(id)).toMatchObject({ status: "active", self_approved: true });
      await askRelease(id, requester);
      await release(id, requester);
      expect(await holdRow(id)).toMatchObject({
        status: "released",
        released_by: requester,
        release_self_approved: true,
      });
    });
  });

  it("lets the requester place a hold on the only other admin (the held one can't approve)", async () => {
    await asSoleAdmin(requester, async () => {
      const held = await user("Held admin", "admin");
      const id = await request({ userId: held });
      expect(await errorCode(approve(id, held))).toBe("42501");
      await approve(id, requester);
      expect(await holdRow(id)).toMatchObject({ status: "active", self_approved: true });
      await askRelease(id, requester);
      await release(id, requester);
      expect(await holdRow(id)).toMatchObject({ status: "released", release_self_approved: true });
      await admin.query(`DELETE FROM install_roles WHERE user_id = $1`, [held]);
    });
  });

  it("releases only through a release request approved by a second install admin", async () => {
    const id = await active({ userId: alice });
    // No release without a request; the requester of the release can't approve it.
    expect(await errorCode(release(id))).toBe("55000");
    await askRelease(id, requester);
    expect(await errorCode(release(id, requester))).toBe("42501");
    expect(await errorCode(release(id, alice))).toBe("42501");
    // Still in force while the release waits.
    expect((await holdRow(id)).status).toBe("active");
    expect(await isUnderLegalHold(app.db, teamA, alice)).toBe(true);
    await release(id, approver);
    expect(await holdRow(id)).toMatchObject({
      status: "released",
      released_by: approver,
      release_self_approved: false,
    });
    expect(await isUnderLegalHold(app.db, teamA, alice)).toBe(false);
  });

  it("lets a release request be cancelled, keeping the hold in force", async () => {
    const id = await active();
    await askRelease(id);
    await appClient.query(
      `UPDATE legal_holds SET release_requested_by = NULL, release_requested_at = NULL,
         release_reason = NULL WHERE id = $1`,
      [id],
    );
    expect(await holdRow(id)).toMatchObject({ status: "active", release_requested_by: null });
    // A release request can't be rewritten in place.
    await askRelease(id);
    expect(
      await errorCode(
        appClient.query(`UPDATE legal_holds SET release_requested_by = $2 WHERE id = $1`, [
          id,
          approver,
        ]),
      ),
    ).toBe("55000");
    await release(id);
  });

  it("closes pending requests: denied by another admin, withdrawn by the requester", async () => {
    const denied = await request();
    expect(
      await errorCode(
        appClient.query(`UPDATE legal_holds SET status = 'denied', closed_by = $2 WHERE id = $1`, [
          denied,
          requester,
        ]),
      ),
    ).toBe("42501");
    await appClient.query(
      `UPDATE legal_holds SET status = 'denied', closed_by = $2 WHERE id = $1`,
      [denied, approver],
    );
    expect(await holdRow(denied)).toMatchObject({ status: "denied", closed_by: approver });

    const withdrawn = await request();
    expect(
      await errorCode(
        appClient.query(
          `UPDATE legal_holds SET status = 'withdrawn', closed_by = $2 WHERE id = $1`,
          [withdrawn, approver],
        ),
      ),
    ).toBe("42501");
    await appClient.query(
      `UPDATE legal_holds SET status = 'withdrawn', closed_by = $2 WHERE id = $1`,
      [withdrawn, requester],
    );
    expect((await holdRow(withdrawn)).status).toBe("withdrawn");
    // Closed requests stay closed.
    expect(await errorCode(approve(withdrawn))).toBe("55000");
  });

  it("keeps the request immutable and the record undeletable", async () => {
    const id = await active();
    for (const change of [
      `UPDATE legal_holds SET reason = 'other' WHERE id = $1`,
      `UPDATE legal_holds SET team_id = '${teamB}' WHERE id = $1`,
      `UPDATE legal_holds SET approved_by = '${requester}' WHERE id = $1`,
      `UPDATE legal_holds SET status = 'pending' WHERE id = $1`,
    ]) {
      expect(await errorCode(appClient.query(change, [id])), change).toMatch(/^(55000|23514)$/);
    }
    expect(await errorCode(appClient.query(`DELETE FROM legal_holds WHERE id = $1`, [id]))).toBe(
      "42501",
    );
    await releaseHold(id);
  });
});

describe("consumer API for purge jobs (KOBE-18, KOBE-28)", () => {
  it("answers per user and team, and conservatively for the whole team", async () => {
    const t = await team();
    expect(await isUnderLegalHold(app.db, t)).toBe(false);
    const userHold = await active({ teamId: t, userId: alice });
    expect(await isUnderLegalHold(app.db, t, alice)).toBe(true);
    expect(await isUnderLegalHold(app.db, t, bob)).toBe(false);
    // Without a user: any hold in the team.
    expect(await isUnderLegalHold(app.db, t)).toBe(true);
    expect(await isUnderLegalHold(app.db, teamB, alice)).toBe(false);
    expect(await legalHoldsForTeam(app.db, t)).toEqual({ team: false, userIds: [alice] });

    const teamHold = await active({ teamId: t });
    expect(await isUnderLegalHold(app.db, t, bob)).toBe(true);
    expect(await legalHoldsForTeam(app.db, t)).toEqual({ team: true, userIds: [alice] });

    const { rows } = await appClient.query<{ a: boolean; b: boolean; none: boolean }>(
      `SELECT legal_hold_covers($1, $2) AS a, legal_hold_covers($1, $3) AS b,
              legal_hold_covers($4, $2) AS none`,
      [t, alice, bob, teamB],
    );
    expect(rows[0]).toEqual({ a: true, b: true, none: false });
    await releaseHold(userHold);
    await releaseHold(teamHold);
    expect(await isUnderLegalHold(app.db, t)).toBe(false);
  });

  it("ignores pending, denied and released holds", async () => {
    const t = await team();
    await request({ teamId: t });
    const released = await active({ teamId: t });
    await releaseHold(released);
    expect(await isUnderLegalHold(app.db, t)).toBe(false);
  });
});

describe("held data survives purges (ac-1)", () => {
  it("refuses to delete a held user's threads and entries; others' go", async () => {
    const t = await team();
    const held = await thread(t, alice);
    const free = await thread(t, bob);
    const hold = await active({ teamId: t, userId: alice });

    const purge = (threadId: string) =>
      withTeam(app.db, t, (tx) =>
        tx.execute(sql.raw(`DELETE FROM threads WHERE team_id = '${t}' AND id = '${threadId}'`)),
      );
    const err = await purge(held).catch((e: unknown) => e);
    expect(isLegalHoldViolation(err)).toBe(true);
    const entries = (threadId: string) =>
      withTeam(app.db, t, (tx) =>
        tx.execute(
          sql.raw(
            `DELETE FROM thread_entries WHERE team_id = '${t}' AND thread_id = '${threadId}'`,
          ),
        ),
      );
    expect(isLegalHoldViolation(await entries(held).catch((e: unknown) => e))).toBe(true);
    await entries(free);
    await purge(free);

    const { rows } = await admin.query<{ id: string; n: number }>(
      `SELECT t.id, (SELECT count(*)::int FROM thread_entries e WHERE e.team_id = t.team_id AND e.thread_id = t.id) AS n
       FROM threads t WHERE t.team_id = $1`,
      [t],
    );
    expect(rows).toEqual([{ id: held, n: 2 }]);

    // Moving to Trash (soft delete) is an update, not a purge: allowed under hold.
    await withTeam(app.db, t, (tx) =>
      tx.execute(
        sql.raw(`UPDATE threads SET deleted_at = now() WHERE team_id = '${t}' AND id = '${held}'`),
      ),
    );
    // Released: the purge goes through.
    await releaseHold(hold);
    await purge(held);
    expect((await admin.query(`SELECT 1 FROM threads WHERE id = $1`, [held])).rowCount).toBe(0);
  });

  it("refuses to move a held thread to another owner, then delete it (review M2)", async () => {
    const t = await team();
    const a = await thread(t, alice, 1);
    const hold = await active({ teamId: t, userId: alice });
    const code = await errorCode(
      withTeam(app.db, t, (tx) =>
        tx.execute(
          sql.raw(
            `UPDATE threads SET owner_user_id = '${bob}' WHERE team_id = '${t}' AND id = '${a}'`,
          ),
        ),
      ),
    );
    expect(code).toBe(LEGAL_HOLD_SQLSTATE);
    // Other updates (title, Trash) stay allowed.
    await withTeam(app.db, t, (tx) =>
      tx.execute(sql.raw(`UPDATE threads SET title = 'x' WHERE team_id = '${t}' AND id = '${a}'`)),
    );
    await releaseHold(hold);
  });

  it("refuses TRUNCATE of threads and entries while any hold is active (owner too)", async () => {
    const owner = new pg.Client({ connectionString: inject("ownerUrl") });
    await owner.connect();
    try {
      const hold = await active();
      for (const table of ["thread_entries", "threads"]) {
        // Inside a rolled-back transaction: the guard must fire before anything is truncated.
        await owner.query("BEGIN");
        expect(await errorCode(owner.query(`TRUNCATE ${table} CASCADE`)), table).toBe(
          LEGAL_HOLD_SQLSTATE,
        );
        await owner.query("ROLLBACK");
      }
      await releaseHold(hold);
    } finally {
      await owner.end();
    }
  });

  it("holds a whole team, Trash included", async () => {
    const t = await team();
    const a = await thread(t, alice);
    const hold = await active({ teamId: t });
    const code = await errorCode(
      withTeam(app.db, t, (tx) =>
        tx.execute(sql.raw(`DELETE FROM threads WHERE team_id = '${t}' AND id = '${a}'`)),
      ),
    );
    expect(code).toBe(LEGAL_HOLD_SQLSTATE);
    await releaseHold(hold);
  });

  it("makes an approval wait for a purge in flight, and later purges see the hold", async () => {
    const t = await team();
    const a = await thread(t, alice, 1);
    const id = await request({ teamId: t, userId: alice });
    const purger = await app.pool.connect();
    try {
      await purger.query("BEGIN");
      await purger.query(`SELECT set_config('kobe.team_id', $1, true)`, [t]);
      await purger.query(`SELECT legal_hold_lock_shared()`);
      // The approval blocks on the purge's shared lock...
      let approvedAt = 0;
      const approval = approve(id).then(() => (approvedAt = Date.now()));
      await new Promise((r) => setTimeout(r, 300));
      expect(approvedAt).toBe(0);
      // ...so the purge, which checked before the approval, may still delete.
      await purger.query(`DELETE FROM thread_entries WHERE team_id = $1 AND thread_id = $2`, [
        t,
        a,
      ]);
      const deletedAt = Date.now();
      await purger.query("COMMIT");
      await approval;
      expect(approvedAt).toBeGreaterThanOrEqual(deletedAt);
    } finally {
      purger.release();
    }
    // A purge that starts now sees the hold.
    const code = await errorCode(
      app.db.transaction(async (tx) => {
        await lockLegalHolds(tx);
        await tx.execute(sql.raw(`SELECT set_config('kobe.team_id', '${t}', true)`));
        await tx.execute(sql.raw(`DELETE FROM threads WHERE team_id = '${t}' AND id = '${a}'`));
      }),
    );
    expect(code).toBe(LEGAL_HOLD_SQLSTATE);
    await releaseHold(id);
  });
});
