import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./client.js";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";
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

  it("is neither cleared, changed nor purged while a hold covers the thread's owner", async () => {
    const t = await team();
    const ann = await user("Ann");
    const bob = await user("Bob");
    const a = await answer(t, ann);
    await rate(a, ann);
    await rate(a, bob, { rating: "up", reasons: "{}", comment: null });
    const h = await hold(t, ann);
    for (const statement of [
      `DELETE FROM answer_feedback WHERE team_id = '${t}' AND user_id = '${bob}'`,
      `UPDATE answer_feedback SET comment = NULL, reasons = '{}', rating = 'up' WHERE team_id = '${t}' AND user_id = '${ann}'`,
      `DELETE FROM threads WHERE team_id = '${t}' AND id = '${a.threadId}'`,
    ]) {
      expect(await errorCode(exec(t, statement)), statement).toBe(LEGAL_HOLD_SQLSTATE);
    }
    expect(await errorCode(owner.query(`TRUNCATE answer_feedback`))).toBe(LEGAL_HOLD_SQLSTATE);
    expect(await count(t)).toBe(2);
    // A new rating removes nothing.
    const carl = await user("Carl");
    expect(await errorCode(rate(a, carl))).toBeUndefined();
    await release(h);
    await exec(t, `DELETE FROM answer_feedback WHERE team_id = '${t}' AND user_id = '${bob}'`);
    expect(await count(t)).toBe(2);
  });

  it("follows the thread's owner, not the rater: a held rater never stalls another's purge", async () => {
    const t = await team();
    const ann = await user("Ann");
    const bob = await user("Bob");
    const a = await answer(t, ann);
    await rate(a, bob);
    const h = await hold(t, bob);
    await exec(t, `DELETE FROM threads WHERE team_id = '${t}' AND id = '${a.threadId}'`);
    expect(await count(t)).toBe(0);
    await release(h);
  });
});
