import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./client.js";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";
import { BREAK_GLASS_ACTOR_SETTING, BREAK_GLASS_GRANT_SETTING } from "./settings.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-275: answer_feedback's constraints, keys, cascades and legal-hold guards (team isolation and
 * break-glass reads: probe.db.test; the policy text: catalog.db.test).
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
    `${id}@fb.test`,
  ]);
  if (role) await admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, $2)`, [id, role]);
  return id;
}

async function team(): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    id,
    `fb-${id.slice(0, 8)}`,
  ]);
  return id;
}

/** A thread owned by `ownerId` with one ended run and one answer entry. */
async function answer(teamId: string, ownerId: string) {
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
  await admin.query(
    `INSERT INTO thread_entries (team_id, thread_id, entry_id, type, payload) VALUES ($1, $2, 'a1', 'message', '{}')`,
    [teamId, threadId],
  );
  return { teamId, threadId, runId: run.rows[0]?.id ?? "" };
}

type Answer = Awaited<ReturnType<typeof answer>>;

const rate = (
  a: Answer,
  userId: string,
  values: {
    rating?: string;
    reasons?: string;
    comment?: string | null;
    entry?: string | null;
  } = {},
) =>
  admin.query(
    `INSERT INTO answer_feedback (team_id, thread_id, run_id, entry_id, user_id, rating, reasons, comment)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8)`,
    [
      a.teamId,
      a.threadId,
      a.runId,
      values.entry === undefined ? "a1" : values.entry,
      userId,
      values.rating ?? "down",
      values.reasons ?? "{wrong}",
      values.comment === undefined ? "made it up" : values.comment,
    ],
  );

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
const count = async (teamId: string) =>
  Number(
    (
      await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM answer_feedback WHERE team_id = $1`,
        [teamId],
      )
    ).rows[0]?.n ?? 0,
  );

const kept = async (teamId: string) =>
  (
    await admin.query<{ user_id: string; rating: string; comment: string | null; change: string }>(
      `SELECT user_id, rating, comment, change FROM answer_feedback_history WHERE team_id = $1
        ORDER BY kept_at, change`,
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

describe("answer_feedback", () => {
  it("keeps one rating per run and member", async () => {
    const t = await team();
    const ann = await user("Ann");
    const bob = await user("Bob");
    const a = await answer(t, ann);
    expect(await errorCode(rate(a, ann))).toBeUndefined();
    expect(await errorCode(rate(a, bob, { rating: "up", reasons: "{}", comment: null }))).toBe(
      undefined,
    );
    expect(await errorCode(rate(a, ann, { rating: "up", reasons: "{}", comment: null }))).toBe(
      "23505",
    );
    expect(await count(t)).toBe(2);
  });

  it.each([
    ["reasons on a thumbs up", { rating: "up", comment: null }],
    ["a comment on a thumbs up", { rating: "up", reasons: "{}" }],
    ["an unknown rating", { rating: "meh" }],
    ["an unknown reason", { reasons: "{boring}" }],
    ["a null reason", { reasons: "{NULL}" }],
    ["too many reasons", { reasons: "{wrong,unsafe,other,too_slow,ignored_instructions,wrong}" }],
    ["an empty comment", { comment: "" }],
    ["an over-long comment", { comment: "x".repeat(501) }],
  ])("refuses %s", async (_name, values) => {
    const t = await team();
    const ann = await user("Ann");
    expect(await errorCode(rate(await answer(t, ann), ann, values))).toBe("23514");
  });

  it("refuses an agent snapshot that doesn't hang together", async () => {
    const t = await team();
    const ann = await user("Ann");
    const a = await answer(t, ann);
    await rate(a, ann);
    const set = (values: string) =>
      admin.query(`UPDATE answer_feedback SET ${values} WHERE team_id = $1`, [t]);
    expect(await errorCode(set(`agent_scope = 'team'`))).toBe("23514");
    expect(await errorCode(set(`agent_version = 1`))).toBe("23514");
    expect(await errorCode(set(`agent_scope = 'team', agent_id = gen_random_uuid()`))).toBe(
      undefined,
    );
    expect(await errorCode(set(`agent_version = 0`))).toBe("23514");
    expect(await errorCode(set(`agent_version = 3, model_alias = 'fast'`))).toBeUndefined();
  });

  it("only names a run, thread and entry of its own team and thread", async () => {
    const t = await team();
    const u = await team();
    const ann = await user("Ann");
    const a = await answer(t, ann);
    const b = await answer(u, ann);
    // Another team's run, thread or entry: the composite keys refuse it.
    expect(await errorCode(rate({ ...a, runId: b.runId }, ann))).toBe("23503");
    expect(await errorCode(rate({ ...a, threadId: b.threadId }, ann))).toBe("23503");
    // An entry the thread doesn't have.
    expect(await errorCode(rate(a, ann, { entry: "nope" }))).toBe("23503");
    expect(await errorCode(rate(a, ann, { entry: null }))).toBeUndefined();
  });

  it("goes with its run, its thread and its team", async () => {
    const t = await team();
    const ann = await user("Ann");
    const a = await answer(t, ann);
    const b = await answer(t, ann);
    const c = await answer(t, ann);
    for (const x of [a, b, c]) await rate(x, ann);
    await admin.query(`DELETE FROM runs WHERE team_id = $1 AND id = $2`, [t, a.runId]);
    expect(await count(t)).toBe(2);
    await admin.query(`DELETE FROM threads WHERE team_id = $1 AND id = $2`, [t, b.threadId]);
    expect(await count(t)).toBe(1);
    await admin.query(`DELETE FROM teams WHERE id = $1`, [t]);
    expect(await count(t)).toBe(0);
  });

  it("keeps a held owner's ratings silently: change and clear go through, the old rows are kept", async () => {
    const t = await team();
    const ann = await user("Ann");
    const bob = await user("Bob");
    const a = await answer(t, ann);
    await rate(a, ann);
    await rate(a, bob, { rating: "up", reasons: "{}", comment: null });
    const h = await hold(t, ann);
    // A retry with the same values keeps nothing.
    expect(
      await errorCode(
        exec(
          t,
          `UPDATE answer_feedback SET updated_at = now() WHERE team_id = '${t}' AND user_id = '${ann}'`,
        ),
      ),
    ).toBeUndefined();
    expect(await kept(t)).toEqual([]);
    for (const statement of [
      `UPDATE answer_feedback SET comment = NULL, reasons = '{}', rating = 'up' WHERE team_id = '${t}' AND user_id = '${ann}'`,
      `DELETE FROM answer_feedback WHERE team_id = '${t}' AND user_id = '${bob}'`,
    ]) {
      expect(await errorCode(exec(t, statement)), statement).toBeUndefined();
    }
    // The members' new state stands; the old values are kept.
    expect(await count(t)).toBe(1);
    expect(await kept(t)).toEqual([
      { user_id: ann, rating: "down", comment: "made it up", change: "changed" },
      { user_id: bob, rating: "up", comment: null, change: "cleared" },
    ]);
    // The thread (and with it everything) can't be purged; the kept rows can't be removed.
    expect(
      await errorCode(
        exec(t, `DELETE FROM threads WHERE team_id = '${t}' AND id = '${a.threadId}'`),
      ),
    ).toBe(LEGAL_HOLD_SQLSTATE);
    expect(
      await errorCode(exec(t, `DELETE FROM answer_feedback_history WHERE team_id = '${t}'`)),
    ).toBe(LEGAL_HOLD_SQLSTATE);
    expect(
      await errorCode(
        exec(t, `UPDATE answer_feedback_history SET comment = 'x' WHERE team_id = '${t}'`),
      ),
    ).toBe("55000");
    expect(await errorCode(owner.query(`TRUNCATE answer_feedback_history`))).toBe(
      LEGAL_HOLD_SQLSTATE,
    );
    // agent_eval_cases' rating key (KOBE-276) refuses a plain TRUNCATE before the hold guard runs.
    expect(await errorCode(owner.query(`TRUNCATE answer_feedback`))).toBe("0A000");
    expect(await count(t)).toBe(1);
    // After the release, nothing more is kept; the history goes with the thread.
    await release(h);
    await exec(t, `DELETE FROM answer_feedback WHERE team_id = '${t}'`);
    expect(await kept(t)).toHaveLength(2);
    await exec(t, `DELETE FROM threads WHERE team_id = '${t}' AND id = '${a.threadId}'`);
    expect(await kept(t)).toEqual([]);
  });

  it("keeps a held rater's own comment on someone else's thread, and never stalls its purge", async () => {
    const t = await team();
    const ann = await user("Ann");
    const bob = await user("Bob");
    const a = await answer(t, ann);
    await rate(a, bob);
    const h = await hold(t, bob);
    await exec(t, `DELETE FROM answer_feedback WHERE team_id = '${t}' AND user_id = '${bob}'`);
    expect(await kept(t)).toEqual([
      { user_id: bob, rating: "down", comment: "made it up", change: "cleared" },
    ]);
    // Ann's thread isn't held: its purge goes through, history included.
    await rate(a, bob, { rating: "up", reasons: "{}", comment: null });
    await exec(t, `DELETE FROM threads WHERE team_id = '${t}' AND id = '${a.threadId}'`);
    expect(await count(t)).toBe(0);
    expect(await kept(t)).toEqual([]);
    await release(h);
  });
});

describe("answer_feedback break-glass read", () => {
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

  /** Comments of both tables the app role sees under a grant (or none), in a rolled-back read. */
  async function visible(grantId: string | null, write?: string) {
    await appClient.query("BEGIN");
    try {
      if (grantId)
        await appClient.query(
          `SELECT set_config('${BREAK_GLASS_GRANT_SETTING}', $1, true), set_config('${BREAK_GLASS_ACTOR_SETTING}', $2, true)`,
          [grantId, requester],
        );
      if (write) return await errorCode(appClient.query(write));
      const { rows } = await appClient.query<{ comment: string }>(
        `SELECT comment FROM answer_feedback UNION ALL SELECT comment FROM answer_feedback_history`,
      );
      return rows.map((r) => r.comment).sort();
    } finally {
      await appClient.query("ROLLBACK");
    }
  }

  it("reads the grant's team, user or thread only, never writes, and nothing once it expired", async () => {
    const t = await team();
    const other = await team();
    const ann = await user("Ann");
    const bob = await user("Bob");
    const a = await answer(t, ann);
    const b = await answer(t, bob);
    await rate(a, ann, { comment: "on ann's" });
    await rate(b, ann, { comment: "ann on bob's" });
    await rate(await answer(other, ann), ann, { comment: "other team" });
    // A held change keeps the old comment in the history, readable under the same grants.
    const h = await hold(t, ann);
    await exec(
      t,
      `UPDATE answer_feedback SET comment = 'on ann''s, edited' WHERE team_id = '${t}' AND thread_id = '${a.threadId}'`,
    );
    await release(h);
    expect(await visible(null)).toEqual([]);
    expect(await visible(await grant(t))).toEqual(["ann on bob's", "on ann's", "on ann's, edited"]);
    expect(await visible(await grant(t, { thread: b.threadId }))).toEqual(["ann on bob's"]);
    // A user grant reads that user's threads (thread content), like thread_entries.
    expect(await visible(await grant(t, { user: ann }))).toEqual(["on ann's", "on ann's, edited"]);
    const g = await grant(t);
    expect(
      await visible(g, `UPDATE answer_feedback SET comment = 'x' WHERE team_id = '${t}'`),
    ).toBeUndefined();
    expect(await count(t)).toBe(2);
    expect((await admin.query(`SELECT 1 FROM answer_feedback WHERE comment = 'x'`)).rowCount).toBe(
      0,
    );
    expect(
      await visible(
        g,
        `INSERT INTO answer_feedback (team_id, thread_id, run_id, user_id, rating) VALUES ('${t}', '${a.threadId}', '${a.runId}', '${bob}', 'up')`,
      ),
    ).toBe("42501");
    // The window passes (superuser, triggers bypassed, as time would).
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
