import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./client.js";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-325 (SK16): skill_eval_runs / skill_eval_results constraints, eval threads, the wire's
 * sandbox slots and the silent legal hold (team isolation: probe.db.test; RLS text: catalog.db.test).
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
        skill_name, package_hash, runtime_hash, bundle_key, mode, suite, limits, progress_total)
      VALUES (${teamId}, ${userId}, 'draft', ${randomUUID()}, 1, 'report', ${H}, ${H},
        'k', 'full', '{"cases":[]}', '{}', 2)
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

describe("sandbox slots (KOBE-325)", () => {
  it("lets one member hold their own sandbox and eval sandboxes at once, slots well-formed", async () => {
    const t = await team();
    const u = await user("Member");
    const evalSlot = `e-${randomUUID()}`;
    const insert = (slot: string) =>
      inTeam(
        t,
        `INSERT INTO sandbox_connections (team_id, user_id, slot, sandbox_id, connection_id, replica_id)
         VALUES ('${t}', '${u}', '${slot}', '${randomUUID()}', '${randomUUID()}', 'r1')`,
      );
    await insert("");
    await insert(evalSlot);
    expect(await pgCode(insert(evalSlot))).toBe("23505");
    expect(await pgCode(insert("e-not-a-uuid"))).toBe("23514");
    const rows = await inTeam(
      t,
      `SELECT slot FROM sandbox_connections WHERE user_id = '${u}' ORDER BY slot`,
    );
    expect(rows.rows).toEqual([{ slot: "" }, { slot: evalSlot }]);
  });
});
