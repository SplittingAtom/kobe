import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./client.js";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-325 (SK16): skill_eval_runs / skill_eval_results constraints, eval threads, eval sandbox
 * connections, the wire's slot rules and the silent legal hold (team isolation: probe.db.test; RLS text: catalog.db.test).
 */
const app = createDb(inject("appUrl"), { max: 4 });
const appClient = new pg.Client({ connectionString: inject("appUrl") });
const admin = new pg.Client({ connectionString: inject("adminUrl") });
let requester = "";
let approver = "";

async function user(name: string, role?: "admin"): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
    id,
    name,
    `${id}@evals.test`,
  ]);
  if (role) await admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, $2)`, [id, role]);
  return id;
}

async function team(): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    id,
    `ev-${id.slice(0, 8)}`,
  ]);
  return id;
}

async function hold(teamId: string, userId: string): Promise<string> {
  const { rows } = await appClient.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
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
    `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(), release_reason = 'done' WHERE id = $1`,
    [id, requester],
  );
  await appClient.query(
    `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
    [id, approver],
  );
}

async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
}

const H = "c".repeat(64);
/** An eval run as the app role inside the team (as the server does). */
async function evalRun(teamId: string, userId: string): Promise<string> {
  const res = await withTeam(app.db, teamId, (tx) =>
    tx.execute<{ id: string }>(sql`
      INSERT INTO skill_eval_runs (team_id, started_by, subject_kind, subject_id, subject_rev,
        skill_name, package_hash, runtime_hash, bundle_key, bundle_size, mode, suite, limits, progress_total)
      VALUES (${teamId}, ${userId}, 'draft', ${randomUUID()}, 1, 'report', ${H}, ${H},
        'k', 10, 'full', '{"cases":[]}', '{}', 2)
      RETURNING id`),
  );
  return res.rows[0]?.id ?? "";
}

const inTeam = (teamId: string, query: string) =>
  withTeam(app.db, teamId, (tx) => tx.execute(sql.raw(query)));

beforeAll(async () => {
  await appClient.connect();
  await admin.connect();
  requester = await user("Requester", "admin");
  approver = await user("Approver", "admin");
});

afterAll(async () => {
  await app.close();
  await appClient.end();
  await admin.end();
});

describe("skill eval rows (KOBE-325)", () => {
  it("holds a scorecard exactly when completed and a failure exactly when failed", async () => {
    const t = await team();
    const u = await user("Author");
    const id = await evalRun(t, u);
    expect(
      await pgCode(
        inTeam(
          t,
          `UPDATE skill_eval_runs SET status = 'completed', finished_at = now() WHERE id = '${id}'`,
        ),
      ),
    ).toBe("23514");
    await inTeam(
      t,
      `UPDATE skill_eval_runs SET status = 'completed', finished_at = now(), scorecard = '{"format":1}' WHERE id = '${id}'`,
    );
    expect(
      await pgCode(inTeam(t, `UPDATE skill_eval_runs SET status = 'failed' WHERE id = '${id}'`)),
    ).toBe("23514");
    expect(
      await pgCode(inTeam(t, `UPDATE skill_eval_runs SET progress_done = 3 WHERE id = '${id}'`)),
    ).toBe("23514");
  });

  it("keeps an execution's result to done rows and its thread in its team", async () => {
    const t = await team();
    const other = await team();
    const u = await user("Author");
    const id = await evalRun(t, u);
    const otherThread = randomUUID();
    await admin.query(
      `INSERT INTO threads (team_id, id, owner_user_id, title, skill_eval) VALUES ($1, $2, $3, 't', true)`,
      [other, otherThread, u],
    );
    await inTeam(
      t,
      `INSERT INTO skill_eval_results (team_id, eval_run_id, case_id, with_skill) VALUES ('${t}', '${id}', 'a', true)`,
    );
    expect(
      await pgCode(
        inTeam(t, `UPDATE skill_eval_results SET state = 'done' WHERE eval_run_id = '${id}'`),
      ),
    ).toBe("23514");
    expect(
      await pgCode(
        inTeam(t, `UPDATE skill_eval_results SET state = 'running' WHERE eval_run_id = '${id}'`),
      ),
    ).toBe("23514");
    expect(
      await pgCode(
        inTeam(
          t,
          `UPDATE skill_eval_results SET state = 'running', deadline_at = now(), thread_id = '${otherThread}' WHERE eval_run_id = '${id}'`,
        ),
      ),
    ).toBe("23503");
  });

  it("marks eval threads, keeps them out of projects and test chats, and clears a gone run", async () => {
    const t = await team();
    const u = await user("Author");
    const id = await evalRun(t, u);
    const thread = randomUUID();
    expect(
      await pgCode(
        inTeam(
          t,
          `INSERT INTO threads (team_id, id, owner_user_id, title, skill_eval_run_id) VALUES ('${t}', '${thread}', '${u}', 't', '${id}')`,
        ),
      ),
    ).toBe("23514");
    expect(
      await pgCode(
        inTeam(
          t,
          `INSERT INTO threads (team_id, id, owner_user_id, title, skill_eval, skill_test) VALUES ('${t}', '${thread}', '${u}', 't', true, true)`,
        ),
      ),
    ).toBe("23514");
    await inTeam(
      t,
      `INSERT INTO threads (team_id, id, owner_user_id, title, skill_eval, skill_eval_run_id) VALUES ('${t}', '${thread}', '${u}', 't', true, '${id}')`,
    );
    await inTeam(
      t,
      `INSERT INTO skill_eval_results (team_id, eval_run_id, case_id, with_skill, state, thread_id, deadline_at) VALUES ('${t}', '${id}', 'a', true, 'running', '${thread}', now())`,
    );
    await inTeam(t, `DELETE FROM threads WHERE id = '${thread}'`);
    const r = await inTeam(
      t,
      `SELECT thread_id FROM skill_eval_results WHERE eval_run_id = '${id}'`,
    );
    expect(r.rows).toEqual([{ thread_id: null }]);
    const thread2 = randomUUID();
    await inTeam(
      t,
      `INSERT INTO threads (team_id, id, owner_user_id, title, skill_eval, skill_eval_run_id) VALUES ('${t}', '${thread2}', '${u}', 't', true, '${id}')`,
    );
    await inTeam(t, `DELETE FROM skill_eval_runs WHERE id = '${id}'`);
    const th = await inTeam(
      t,
      `SELECT skill_eval, skill_eval_run_id FROM threads WHERE id = '${thread2}'`,
    );
    expect(th.rows).toEqual([{ skill_eval: true, skill_eval_run_id: null }]);
    const gone = await inTeam(t, `SELECT 1 FROM skill_eval_results WHERE eval_run_id = '${id}'`);
    expect(gone.rows).toEqual([]);
  });

  it("skips a purge of a held starter's eval silently, and purges it once released", async () => {
    const t = await team();
    const u = await user("Held");
    const id = await evalRun(t, u);
    await inTeam(
      t,
      `INSERT INTO skill_eval_results (team_id, eval_run_id, case_id, with_skill) VALUES ('${t}', '${id}', 'a', true)`,
    );
    const h = await hold(t, u);
    const del = await inTeam(t, `DELETE FROM skill_eval_runs WHERE id = '${id}'`);
    expect(del.rowCount).toBe(0);
    const res = await inTeam(t, `DELETE FROM skill_eval_results WHERE eval_run_id = '${id}'`);
    expect(res.rowCount).toBe(0);
    expect(await pgCode(admin.query(`TRUNCATE skill_eval_results`))).toBe(LEGAL_HOLD_SQLSTATE);
    const still = await inTeam(
      t,
      `SELECT count(*)::int AS n FROM skill_eval_results WHERE eval_run_id = '${id}'`,
    );
    expect(still.rows).toEqual([{ n: 1 }]);
    await release(h);
    const after = await inTeam(t, `DELETE FROM skill_eval_runs WHERE id = '${id}'`);
    expect(after.rowCount).toBe(1);
  });
});

describe("eval sandboxes on the wire (KOBE-325)", () => {
  const thread = async (t: string, u: string, evalThread: boolean, runId?: string) => {
    const id = randomUUID();
    await inTeam(
      t,
      `INSERT INTO threads (team_id, id, owner_user_id, title, skill_eval, skill_eval_run_id)
       VALUES ('${t}', '${id}', '${u}', 't', ${evalThread}, ${runId ? `'${runId}'` : "NULL"})`,
    );
    return id;
  };
  const evalConnection = (t: string, u: string, threadId: string) =>
    inTeam(
      t,
      `INSERT INTO sandbox_eval_connections (team_id, thread_id, user_id, sandbox_id, connection_id, replica_id)
       VALUES ('${t}', '${threadId}', '${u}', '${randomUUID()}', '${randomUUID()}', 'r1')`,
    );
  const command = (t: string, u: string, threadId: string, slot: string) =>
    inTeam(
      t,
      `INSERT INTO sandbox_commands (team_id, user_id, slot, thread_id, kind, frame, requester_replica, expires_at)
       VALUES ('${t}', '${u}', '${slot}', '${threadId}', 'run.stop', '{}', 'r1', now() + interval '1 minute')`,
    );
  const lease = async (t: string, u: string, threadId: string, slot: string) => {
    const run = await inTeam(
      t,
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, ended_at)
       VALUES ('${t}', '${threadId}', 'user', 'completed', now(), now()) RETURNING id`,
    );
    const runId = (run.rows[0] as { id: string }).id;
    return inTeam(
      t,
      `INSERT INTO sandbox_run_leases (team_id, run_id, user_id, slot, thread_id, sandbox_id)
       VALUES ('${t}', '${runId}', '${u}', '${slot}', '${threadId}', '${randomUUID()}')`,
    );
  };

  it("keeps a member's own connection apart from their eval sandboxes, one per eval thread", async () => {
    const t = await team();
    const u = await user("Member");
    const other = await user("Other");
    await inTeam(
      t,
      `INSERT INTO sandbox_connections (team_id, user_id, sandbox_id, connection_id, replica_id)
       VALUES ('${t}', '${u}', '${randomUUID()}', '${randomUUID()}', 'r1')`,
    );
    const a = await thread(t, u, true);
    const b = await thread(t, u, true);
    await evalConnection(t, u, a);
    await evalConnection(t, u, b);
    expect(await pgCode(evalConnection(t, u, a))).toBe("23505");
    // Only an eval thread, and only as its owner.
    expect(await pgCode(evalConnection(t, u, await thread(t, u, false)))).toBe("23514");
    expect(await pgCode(evalConnection(t, other, await thread(t, u, true)))).toBe("23514");
    expect(await pgCode(evalConnection(t, u, randomUUID()))).toBe("23503");
    const own = await inTeam(
      t,
      `SELECT count(*)::int AS n FROM sandbox_connections WHERE user_id = '${u}'`,
    );
    expect(own.rows).toEqual([{ n: 1 }]);
    await inTeam(t, `DELETE FROM threads WHERE id = '${a}'`);
    const left = await inTeam(
      t,
      `SELECT thread_id FROM sandbox_eval_connections WHERE user_id = '${u}'`,
    );
    expect(left.rows).toEqual([{ thread_id: b }]);
  });

  it("routes a normal thread's commands and leases only to the member's sandbox, an eval thread's only to its own", async () => {
    const t = await team();
    const u = await user("Member");
    const normal = await thread(t, u, false);
    const ev = await thread(t, u, true);
    const ev2 = await thread(t, u, true);
    for (const insert of [command, lease]) {
      await insert(t, u, normal, "");
      await insert(t, u, ev, `e-${ev}`);
      // A normal thread never reaches an eval sandbox, its own id or another's.
      expect(await pgCode(insert(t, u, normal, `e-${normal}`))).toBe("23514");
      expect(await pgCode(insert(t, u, normal, `e-${ev}`))).toBe("23514");
      // An eval thread never reaches the member's sandbox or another eval thread's.
      expect(await pgCode(insert(t, u, ev, ""))).toBe("23514");
      expect(await pgCode(insert(t, u, ev, `e-${ev2}`))).toBe("23514");
      expect(await pgCode(insert(t, u, normal, "e-not-a-uuid"))).toBe("23514");
    }
    expect(
      await pgCode(inTeam(t, `UPDATE sandbox_commands SET slot = '' WHERE thread_id = '${ev}'`)),
    ).toBe("23514");
  });

  it("never turns a thread into an eval thread or back", async () => {
    const t = await team();
    const u = await user("Member");
    const normal = await thread(t, u, false);
    const ev = await thread(t, u, true);
    expect(
      await pgCode(inTeam(t, `UPDATE threads SET skill_eval = true WHERE id = '${normal}'`)),
    ).toBe("55000");
    expect(
      await pgCode(inTeam(t, `UPDATE threads SET skill_eval = false WHERE id = '${ev}'`)),
    ).toBe("55000");
    await inTeam(t, `UPDATE threads SET title = 'renamed' WHERE id = '${ev}'`);
  });

  it("keeps an eval thread on its eval run (only cleared) and an eval lease on its sandbox", async () => {
    const t = await team();
    const u = await user("Author");
    const id = await evalRun(t, u);
    const other = await evalRun(t, u);
    const ev = await thread(t, u, true, id);
    expect(
      await pgCode(
        inTeam(t, `UPDATE threads SET skill_eval_run_id = '${other}' WHERE id = '${ev}'`),
      ),
    ).toBe("55000");
    await inTeam(t, `UPDATE threads SET skill_eval_run_id = NULL WHERE id = '${ev}'`);
    expect(
      await pgCode(inTeam(t, `UPDATE threads SET skill_eval_run_id = '${id}' WHERE id = '${ev}'`)),
    ).toBe("55000");
    const normal = await thread(t, u, false);
    await lease(t, u, ev, `e-${ev}`);
    await lease(t, u, normal, "");
    expect(
      await pgCode(
        inTeam(
          t,
          `UPDATE sandbox_run_leases SET sandbox_id = '${randomUUID()}' WHERE thread_id = '${ev}'`,
        ),
      ),
    ).toBe("55000");
    // A member's lease may still move to a re-created claim.
    await inTeam(
      t,
      `UPDATE sandbox_run_leases SET sandbox_id = '${randomUUID()}' WHERE thread_id = '${normal}'`,
    );
  });

  it("ties a result's thread to an eval thread of its own eval run", async () => {
    const t = await team();
    const u = await user("Author");
    const id = await evalRun(t, u);
    const otherRun = await evalRun(t, u);
    const result = (threadId: string) =>
      inTeam(
        t,
        `INSERT INTO skill_eval_results (team_id, eval_run_id, case_id, with_skill, state, thread_id, deadline_at)
         VALUES ('${t}', '${id}', 'a', true, 'running', '${threadId}', now())`,
      );
    expect(await pgCode(result(await thread(t, u, false)))).toBe("23514");
    expect(await pgCode(result(await thread(t, u, true, otherRun)))).toBe("23514");
    expect(await pgCode(result(await thread(t, u, true)))).toBe("23514");
    await result(await thread(t, u, true, id));
  });

  it("returns a purged run's object keys only when the delete removed it", async () => {
    const t = await team();
    const u = await user("Held");
    const id = await evalRun(t, u);
    await inTeam(
      t,
      `UPDATE skill_eval_runs SET fixtures_key = 'teams/x/skill-evals/y/fixtures.zip' WHERE id = '${id}'`,
    );
    const h = await hold(t, u);
    const held = await inTeam(
      t,
      `DELETE FROM skill_eval_runs WHERE id = '${id}' RETURNING bundle_key, fixtures_key`,
    );
    expect(held.rows).toEqual([]);
    await release(h);
    const purged = await inTeam(
      t,
      `DELETE FROM skill_eval_runs WHERE id = '${id}' RETURNING bundle_key, fixtures_key`,
    );
    expect(purged.rows).toEqual([
      { bundle_key: "k", fixtures_key: "teams/x/skill-evals/y/fixtures.zip" },
    ]);
  });
});
