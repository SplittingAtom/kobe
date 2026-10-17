import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./client.js";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";
import { BREAK_GLASS_ACTOR_SETTING, BREAK_GLASS_GRANT_SETTING } from "./settings.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-276: agent_eval_cases' constraints, the rating key, immutability, the legal-hold history
 * and break-glass reads (team isolation: probe.db.test; the policy text: catalog.db.test).
 */
const app = createDb(inject("appUrl"), { max: 4 });
const appClient = new pg.Client({ connectionString: inject("appUrl") });
const admin = new pg.Client({ connectionString: inject("adminUrl") });
const owner = new pg.Client({ connectionString: inject("ownerUrl") });
let requester = "";
let approver = "";

async function user(name: string, role?: "admin"): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
    id,
    name,
    `${id}@cases.test`,
  ]);
  if (role) await admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, $2)`, [id, role]);
  return id;
}

async function team(): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    id,
    `ec-${id.slice(0, 8)}`,
  ]);
  return id;
}

/** A thumbs down by `ownerId` on their own thread's ended run; returns its ids. */
async function rating(teamId: string, ownerId: string) {
  const threadId = randomUUID();
  await admin.query(
    `INSERT INTO threads (team_id, id, owner_user_id, title) VALUES ($1, $2, $3, 't')`,
    [teamId, threadId, ownerId],
  );
  const run = await admin.query<{ id: string }>(
    `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, ended_at)
     VALUES ($1, $2, 'user', 'completed', now(), now()) RETURNING id`,
    [teamId, threadId],
  );
  const runId = run.rows[0]?.id ?? "";
  const fb = await admin.query<{ id: string }>(
    `INSERT INTO answer_feedback (team_id, thread_id, run_id, user_id, rating, reasons, comment)
     VALUES ($1, $2, $3, $4, 'down', '{wrong}', 'made it up') RETURNING id`,
    [teamId, threadId, runId, ownerId],
  );
  return { teamId, threadId, runId, feedbackId: fb.rows[0]?.id ?? "" };
}

const AGENT = randomUUID();

/** Shares a case as the app role inside the team (as the server does). */
async function share(
  teamId: string,
  userId: string,
  values: { feedbackId?: string | null; content?: string; status?: string; expected?: string } = {},
): Promise<string> {
  const res = await withTeam(app.db, teamId, (tx) =>
    tx.execute<{ id: string }>(sql`
      INSERT INTO agent_eval_cases
        (team_id, feedback_id, user_id, agent_scope, agent_id, agent_version, content, status,
         expected_behaviour, reviewed_at)
      VALUES (${teamId}, ${values.feedbackId ?? null}, ${userId}, 'team', ${AGENT}, 1,
        ${values.content ?? '{"prompt":"p","answer":"a"}'}::jsonb, ${values.status ?? "open"},
        ${values.expected ?? null}, ${values.status && values.status !== "open" ? new Date().toISOString() : null})
      RETURNING id`),
  );
  return res.rows[0]?.id ?? "";
}

async function hold(teamId: string, userId: string | null): Promise<string> {
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
  await admin.query(
    `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(), release_reason = 'done' WHERE id = $1`,
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
const cases = async (teamId: string) =>
  (
    await admin.query<{ id: string; feedback_id: string | null; status: string }>(
      `SELECT id, feedback_id, status FROM agent_eval_cases WHERE team_id = $1 ORDER BY created_at`,
      [teamId],
    )
  ).rows;
const kept = async (teamId: string) =>
  (
    await admin.query<{ case_id: string; user_id: string; status: string; prompt: string }>(
      `SELECT case_id, user_id, status, content ->> 'prompt' AS prompt
         FROM agent_eval_case_history WHERE team_id = $1 ORDER BY kept_at`,
      [teamId],
    )
  ).rows;

beforeAll(async () => {
  await appClient.connect();
  await admin.connect();
  await owner.connect();
  requester = await user("Requester", "admin");
  approver = await user("Approver", "admin");
});
afterAll(async () => {
  await app.close();
  await appClient.end();
  await admin.end();
  await owner.end();
});

describe("agent_eval_cases", () => {
  it("keeps one case per rating, and the case when the rating is cleared", async () => {
    const t = await team();
    const ann = await user("Ann");
    const r = await rating(t, ann);
    const id = await share(t, ann, { feedbackId: r.feedbackId });
    expect(await errorCode(share(t, ann, { feedbackId: r.feedbackId }))).toBe("23505");
    // Clearing the rating keeps the case (ON DELETE SET NULL (feedback_id)), team_id intact.
    await exec(t, `DELETE FROM answer_feedback WHERE team_id = '${t}' AND id = '${r.feedbackId}'`);
    expect(await cases(t)).toEqual([{ id, feedback_id: null, status: "open" }]);
    // And it survives its thread: nothing ties it to the conversation.
    await admin.query(`DELETE FROM threads WHERE team_id = $1 AND id = $2`, [t, r.threadId]);
    expect(await cases(t)).toHaveLength(1);
  });

  it("names a rating of its own team only", async () => {
    const t = await team();
    const u = await team();
    const ann = await user("Ann");
    const other = await rating(u, ann);
    expect(await errorCode(share(t, ann, { feedbackId: other.feedbackId }))).toBe("23503");
  });

  it.each([
    ["an unknown status", { status: "done", expected: "x" }],
    ["an accepted case without an expected behaviour", { status: "accepted" }],
    ["an empty expected behaviour", { expected: "" }],
    ["an over-long expected behaviour", { expected: "x".repeat(2001) }],
    ["content that is not an object", { content: '"text"' }],
    ["an over-large copy", { content: JSON.stringify({ prompt: "x".repeat(140_000) }) }],
  ])("refuses %s", async (_name, values) => {
    const t = await team();
    const ann = await user("Ann");
    expect(await errorCode(share(t, ann, values))).toBe("23514");
  });

  it("refuses a gallery agent, a reviewed status without a time and a bad version", async () => {
    const t = await team();
    const ann = await user("Ann");
    const id = await share(t, ann);
    const set = (values: string) =>
      admin.query(`UPDATE agent_eval_cases SET ${values} WHERE team_id = $1 AND id = $2`, [t, id]);
    expect(
      await errorCode(
        admin.query(
          `INSERT INTO agent_eval_cases (team_id, user_id, agent_scope, agent_id, content)
           VALUES ($1, $2, 'gallery', gen_random_uuid(), '{}')`,
          [t, ann],
        ),
      ),
    ).toBe("23514");
    expect(await errorCode(set(`status = 'dismissed'`))).toBe("23514");
    expect(await errorCode(set(`status = 'dismissed', reviewed_at = now()`))).toBeUndefined();
    expect(
      await errorCode(
        admin.query(
          `INSERT INTO agent_eval_cases (team_id, user_id, agent_scope, agent_id, agent_version, content)
           VALUES ($1, $2, 'team', gen_random_uuid(), 0, '{}')`,
          [t, ann],
        ),
      ),
    ).toBe("23514");
  });

  it("keeps the copy and its sharer immutable; only the review changes", async () => {
    const t = await team();
    const ann = await user("Ann");
    const bob = await user("Bob");
    const r = await rating(t, ann);
    const id = await share(t, ann, { feedbackId: r.feedbackId });
    const where = `WHERE team_id = '${t}' AND id = '${id}'`;
    for (const change of [
      `content = '{"prompt":"edited"}'`,
      `user_id = '${bob}'`,
      `agent_id = gen_random_uuid()`,
      `agent_version = 2`,
      `agent_scope = 'personal'`,
      `created_at = now() - interval '1 day'`,
      `feedback_id = gen_random_uuid()`,
    ]) {
      expect(
        await errorCode(exec(t, `UPDATE agent_eval_cases SET ${change} ${where}`)),
        change,
      ).toBe("55000");
    }
    expect(
      await errorCode(
        exec(
          t,
          `UPDATE agent_eval_cases SET status = 'accepted', expected_behaviour = 'Cite the source.', reviewed_at = now() ${where}`,
        ),
      ),
    ).toBeUndefined();
    expect(await cases(t)).toEqual([{ id, feedback_id: r.feedbackId, status: "accepted" }]);
    // Hidden for a hold (re-review R1): set once, never cleared or moved.
    expect(
      await errorCode(exec(t, `UPDATE agent_eval_cases SET hidden_at = now() ${where}`)),
    ).toBeUndefined();
    for (const change of [`hidden_at = NULL`, `hidden_at = now() + interval '1 day'`]) {
      expect(
        await errorCode(exec(t, `UPDATE agent_eval_cases SET ${change} ${where}`)),
        change,
      ).toBe("55000");
    }
  });

  it("goes with its team", async () => {
    const t = await team();
    const ann = await user("Ann");
    await share(t, ann);
    await admin.query(`DELETE FROM teams WHERE id = $1`, [t]);
    expect(await cases(t)).toEqual([]);
  });

  it("withdraws under a hold like without one, keeps the copy, and lets it go after the release", async () => {
    const t = await team();
    const ann = await user("Ann");
    const bob = await user("Bob");
    const held = await share(t, ann, { content: '{"prompt":"held"}' });
    const free = await share(t, bob, { content: '{"prompt":"free"}' });
    const h = await hold(t, ann);
    // Both withdrawals succeed in the same way; only the held member's copy is kept.
    for (const id of [held, free]) {
      const res = await exec(
        t,
        `DELETE FROM agent_eval_cases WHERE team_id = '${t}' AND id = '${id}'`,
      );
      expect(res.rowCount).toBe(1);
    }
    expect(await cases(t)).toEqual([]);
    expect(await kept(t)).toEqual([
      { case_id: held, user_id: ann, status: "open", prompt: "held" },
    ]);
    // The kept copy can't be changed or removed while held; neither table can be truncated.
    expect(
      await errorCode(exec(t, `DELETE FROM agent_eval_case_history WHERE team_id = '${t}'`)),
    ).toBe(LEGAL_HOLD_SQLSTATE);
    expect(
      await errorCode(
        exec(t, `UPDATE agent_eval_case_history SET status = 'accepted' WHERE team_id = '${t}'`),
      ),
    ).toBe("55000");
    for (const table of ["agent_eval_cases", "agent_eval_case_history"]) {
      expect(await errorCode(owner.query(`TRUNCATE ${table}`)), table).toBe(LEGAL_HOLD_SQLSTATE);
    }
    // A team-wide hold covers every member's withdrawal too.
    await release(h);
    const teamHold = await hold(t, null);
    const again = await share(t, bob, { content: '{"prompt":"team held"}' });
    await exec(t, `DELETE FROM agent_eval_cases WHERE team_id = '${t}' AND id = '${again}'`);
    expect((await kept(t)).map((k) => k.prompt)).toEqual(["held", "team held"]);
    await release(teamHold);
    // Released: the copies may go (the retention pass purges them); new withdrawals keep nothing.
    const later = await share(t, ann);
    await exec(t, `DELETE FROM agent_eval_cases WHERE team_id = '${t}' AND id = '${later}'`);
    expect(await kept(t)).toHaveLength(2);
    expect(
      await errorCode(exec(t, `DELETE FROM agent_eval_case_history WHERE team_id = '${t}'`)),
    ).toBeUndefined();
    expect(await kept(t)).toEqual([]);
  });
});

describe("agent_eval_cases break-glass read", () => {
  async function grant(teamId: string, scope: { thread?: string; user?: string } = {}) {
    const { rows } = await appClient.query<{ id: string }>(
      `INSERT INTO break_glass_grants (team_id, admin_id, thread_id, user_id, reason)
       VALUES ($1, $2, $3, $4, 'probe') RETURNING id`,
      [teamId, requester, scope.thread ?? null, scope.user ?? null],
    );
    const id = rows[0]?.id ?? "";
    await appClient.query(
      `UPDATE break_glass_grants SET status = 'approved', approver_id = $2 WHERE id = $1`,
      [id, approver],
    );
    return id;
  }

  /** Prompts of both tables the app role sees under a grant (or none), in a rolled-back read. */
  async function visible(grantId: string | null, write?: string) {
    await appClient.query("BEGIN");
    try {
      if (grantId)
        await appClient.query(
          `SELECT set_config('${BREAK_GLASS_GRANT_SETTING}', $1, true), set_config('${BREAK_GLASS_ACTOR_SETTING}', $2, true)`,
          [grantId, requester],
        );
      if (write) return await errorCode(appClient.query(write));
      const { rows } = await appClient.query<{ prompt: string }>(
        `SELECT content ->> 'prompt' AS prompt FROM agent_eval_cases
         UNION ALL SELECT content ->> 'prompt' FROM agent_eval_case_history`,
      );
      return rows.map((r) => r.prompt).sort();
    } finally {
      await appClient.query("ROLLBACK");
    }
  }

  it("reads the grant's team or user only, never by thread, never writes, nothing after expiry", async () => {
    const t = await team();
    const other = await team();
    const ann = await user("Ann");
    const bob = await user("Bob");
    const r = await rating(t, ann);
    await share(t, ann, { content: '{"prompt":"ann"}' });
    await share(t, bob, { content: '{"prompt":"bob"}' });
    await share(other, ann, { content: '{"prompt":"other team"}' });
    // A withdrawal under a hold keeps a copy, readable under the same grants.
    const h = await hold(t, ann);
    const gone = await share(t, ann, { content: '{"prompt":"ann withdrawn"}' });
    await exec(t, `DELETE FROM agent_eval_cases WHERE team_id = '${t}' AND id = '${gone}'`);
    await release(h);
    expect(await visible(null)).toEqual([]);
    expect(await visible(await grant(t))).toEqual(["ann", "ann withdrawn", "bob"]);
    expect(await visible(await grant(t, { user: ann }))).toEqual(["ann", "ann withdrawn"]);
    // A case is no thread's content: a thread grant reads none (not even the rated thread's).
    expect(await visible(await grant(t, { thread: r.threadId }))).toEqual([]);
    const g = await grant(t);
    expect(
      await visible(g, `UPDATE agent_eval_cases SET status = 'open' WHERE team_id = '${t}'`),
    ).toBeUndefined();
    expect(
      await visible(
        g,
        `INSERT INTO agent_eval_cases (team_id, user_id, agent_scope, agent_id, content)
         VALUES ('${t}', '${bob}', 'team', gen_random_uuid(), '{}')`,
      ),
    ).toBe("42501");
    await admin.query(`SET session_replication_role = replica`);
    await admin.query(
      `UPDATE break_glass_grants SET starts_at = now() - interval '2 hours', expires_at = now() - interval '1 hour',
         request_expires_at = now() - interval '1 hour' WHERE id = $1`,
      [g],
    );
    await admin.query(`SET session_replication_role = origin`);
    expect(await visible(g)).toEqual([]);
  });
});
