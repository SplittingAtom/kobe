import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./client.js";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-18 in the data layer: the legal-hold delete guards on the further tables a purge deletes
 * from (runs, run_events), the retention tables' constraints, and team isolation of both.
 */
const app = createDb(inject("appUrl"), { max: 4 });
const appClient = new pg.Client({ connectionString: inject("appUrl") });
// Superuser: fixtures under FORCE RLS.
const admin = new pg.Client({ connectionString: inject("adminUrl") });

let requester = "";
let approver = "";
let alice = "";
let bob = "";

async function user(name: string, role?: "admin"): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
    id,
    name,
    `${id}@ret.test`,
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
    `ret-${id.slice(0, 8)}`,
  ]);
  return id;
}

/** A thread with one ended run and `events` run events. */
async function threadWithRun(teamId: string, owner: string, events = 3) {
  const threadId = randomUUID();
  await admin.query(
    `INSERT INTO threads (team_id, id, owner_user_id, title) VALUES ($1, $2, $3, 't')`,
    [teamId, threadId, owner],
  );
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, ended_at)
     VALUES ($1, $2, 'user', 'completed', now(), now()) RETURNING id`,
    [teamId, threadId],
  );
  const runId = rows[0]?.id ?? "";
  for (let i = 0; i < events; i++) {
    await admin.query(
      `INSERT INTO run_events (team_id, run_id, type, payload) VALUES ($1, $2, 'run.started', '{}')`,
      [teamId, runId],
    );
  }
  return { threadId, runId };
}

async function hold(teamId: string, userId: string | null): Promise<string> {
  const { rows } = await appClient.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter 18', $3)
     RETURNING id`,
    [teamId, userId, requester],
  );
  const id = rows[0]?.id ?? "";
  await appClient.query(
    `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
    [id, approver],
  );
  return id;
}

async function release(id: string): Promise<void> {
  await appClient.query(
    `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(),
       release_reason = 'matter closed' WHERE id = $1`,
    [id, requester],
  );
  await appClient.query(
    `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
    [id, approver],
  );
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

const exec = (teamId: string, text: string) =>
  withTeam(app.db, teamId, (tx) => tx.execute(sql.raw(text)));

const count = async (text: string, params: unknown[]) =>
  Number((await admin.query<{ n: string }>(text, params)).rows[0]?.n ?? 0);

beforeAll(async () => {
  await appClient.connect();
  await admin.connect();
  requester = await user("Requester", "admin");
  approver = await user("Approver", "admin");
  alice = await user("Alice");
  bob = await user("Bob");
});

afterAll(async () => {
  await app.close();
  await appClient.end();
  await admin.end();
});

describe("legal hold guards on runs and run_events (KOBE-17 contract)", () => {
  it("refuses to delete a held user's run events and runs; others' go", async () => {
    const t = await team();
    const held = await threadWithRun(t, alice);
    const free = await threadWithRun(t, bob);
    const h = await hold(t, alice);

    expect(
      await errorCode(
        exec(t, `DELETE FROM run_events WHERE team_id = '${t}' AND run_id = '${held.runId}'`),
      ),
    ).toBe(LEGAL_HOLD_SQLSTATE);
    expect(
      await errorCode(exec(t, `DELETE FROM runs WHERE team_id = '${t}' AND id = '${held.runId}'`)),
    ).toBe(LEGAL_HOLD_SQLSTATE);
    // A bulk delete that includes a held row fails as a whole.
    expect(await errorCode(exec(t, `DELETE FROM run_events WHERE team_id = '${t}'`))).toBe(
      LEGAL_HOLD_SQLSTATE,
    );
    await exec(t, `DELETE FROM run_events WHERE team_id = '${t}' AND run_id = '${free.runId}'`);
    await exec(t, `DELETE FROM runs WHERE team_id = '${t}' AND id = '${free.runId}'`);

    expect(await count(`SELECT count(*) AS n FROM run_events WHERE team_id = $1`, [t])).toBe(3);
    expect(await count(`SELECT count(*) AS n FROM runs WHERE team_id = $1`, [t])).toBe(1);

    await release(h);
    await exec(t, `DELETE FROM run_events WHERE team_id = '${t}' AND run_id = '${held.runId}'`);
    expect(await count(`SELECT count(*) AS n FROM run_events WHERE team_id = $1`, [t])).toBe(0);
  });

  it("a team-wide hold covers cascades from a thread delete too", async () => {
    const t = await team();
    const a = await threadWithRun(t, alice);
    const h = await hold(t, null);
    expect(
      await errorCode(
        exec(t, `DELETE FROM runs WHERE team_id = '${t}' AND thread_id = '${a.threadId}'`),
      ),
    ).toBe(LEGAL_HOLD_SQLSTATE);
    expect(
      await errorCode(
        exec(t, `DELETE FROM threads WHERE team_id = '${t}' AND id = '${a.threadId}'`),
      ),
    ).toBe(LEGAL_HOLD_SQLSTATE);
    await release(h);
    await exec(t, `DELETE FROM threads WHERE team_id = '${t}' AND id = '${a.threadId}'`);
    expect(await count(`SELECT count(*) AS n FROM run_events WHERE team_id = $1`, [t])).toBe(0);
  });

  it("a hold in another team does not block this team's deletes", async () => {
    const t = await team();
    const other = await team();
    const a = await threadWithRun(t, alice);
    const h = await hold(other, null);
    await exec(t, `DELETE FROM threads WHERE team_id = '${t}' AND id = '${a.threadId}'`);
    await release(h);
  });

  it("refuses TRUNCATE of runs and run_events while a hold is active (owner included)", async () => {
    const t = await team();
    const h = await hold(t, alice);
    expect(await errorCode(admin.query(`TRUNCATE run_events`))).toBe(LEGAL_HOLD_SQLSTATE);
    expect(await errorCode(admin.query(`TRUNCATE runs CASCADE`))).toBe(LEGAL_HOLD_SQLSTATE);
    await release(h);
  });
});

describe("retention tables", () => {
  it("accept only the D18 periods and are team-isolated", async () => {
    const t = await team();
    const other = await team();
    expect(
      await errorCode(
        exec(
          t,
          `INSERT INTO team_retention (team_id, period, updated_by) VALUES ('${t}', '7d', '${alice}')`,
        ),
      ),
    ).toBe("23514");
    await exec(
      t,
      `INSERT INTO team_retention (team_id, period, updated_by) VALUES ('${t}', '90d', '${alice}')`,
    );
    await exec(
      t,
      `INSERT INTO retention_blob_deletions (team_id, key, owner_user_id) VALUES ('${t}', 'teams/${t}/x', '${alice}')`,
    );
    const seen = await withTeam(app.db, other, async (tx) => {
      const a = await tx.execute(sql`SELECT count(*)::int AS n FROM team_retention`);
      const b = await tx.execute(sql`SELECT count(*)::int AS n FROM retention_blob_deletions`);
      return [a.rows[0]?.n, b.rows[0]?.n];
    });
    expect(seen).toEqual([0, 0]);
    // Writing another team's row is refused by the policy's WITH CHECK.
    expect(
      await errorCode(
        exec(
          other,
          `INSERT INTO team_retention (team_id, period, updated_by) VALUES ('${t}', '30d', '${alice}')`,
        ),
      ),
    ).toBe("42501");
  });
});
