import { randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTraceId } from "@kobe/protocol";
import type { ScoreSink, TraceScore } from "@kobe/telemetry";
import { FeedbackScores } from "./feedback/scores.js";
import type { GalleryDefinition } from "./gallery/definitions.js";
import { seedGalleryAgents } from "./gallery/seed.js";
import { runRetentionPass } from "./retention/index.js";
import { RunFixture, type RunWorld } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-275: answer feedback through the API. Members rate answers they can see (the owner and
 * readers of a shared thread), each for themselves; changes and clears; agent owners and team
 * admins read count-only totals; ratings follow their thread (Trash purge, legal hold, export);
 * a Langfuse sink receives scores on the run's trace without the comment (capture off).
 */
const ANY = { "if-match": "*" };
const GALLERY: GalleryDefinition = {
  key: "fixture-rated",
  generation: 1,
  file: "---\nname: Fixture Rated\ndescription: A fixture for the rating tests\n---\nYou answer.\n",
};

class RecordingSink implements ScoreSink {
  readonly calls: ({ op: "upsert"; score: TraceScore } | { op: "remove"; id: string })[] = [];
  upsert(score: TraceScore): Promise<void> {
    this.calls.push({ op: "upsert", score });
    return Promise.resolve();
  }
  remove(id: string): Promise<void> {
    this.calls.push({ op: "remove", id });
    return Promise.resolve();
  }
}

const sink = new RecordingSink();
const f = new RunFixture();

beforeAll(async () => {
  await f.setup({ feedbackScores: { sink, captureContent: false } });
});
afterAll(async () => {
  await f.teardown();
});

const as = (p: Person) => f.on(0, p);
const scores = async () => {
  for (const r of f.fx.replicas) await r.deps.feedbackScores?.idle();
  return sink.calls;
};

/** A team agent published by `builder`; returns its id. */
async function publishedAgent(builder: Person): Promise<string> {
  const b = as(builder);
  const created = await b.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: `Rated ${randomUUID().slice(0, 6)}` },
    prompt: "You answer.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  const pub = await b.request("POST", `/v1/agents/${id}/publish`, {}, ANY);
  expect(pub.status, JSON.stringify(pub.json)).toBe(201);
  return id;
}

/**
 * A team (admin `w.owner`), an author and a reader (plain members), and one finished answer by the
 * author on a thread pinned to a team agent the admin published.
 */
async function world() {
  const w = await f.world();
  const author = await f.member(w.team);
  const reader = await f.member(w.team);
  const agentId = await publishedAgent(w.owner);
  const made = await as(author).post("/v1/threads", { agent_id: agentId });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const threadId = made.json.thread_id as string;
  const authorWorld: RunWorld = {
    team: w.team,
    owner: author,
    target: { teamId: w.team, userId: author.id },
  };
  const ws = await f.connect(authorWorld, 0);
  const answer = async (text: string) => {
    const runId = await f.message(author, threadId, text);
    const start = await ws.started(runId);
    const entries = ws.reply(start, `re: ${text}`);
    await ws.acked(runId);
    await f.until(w.team, runId, "completed");
    // The run's prompt entry is bound after the end commits (`onRunEnded` -> `bindUserEntry`, a
    // transaction of its own), so "completed" alone can still list `user_entry_id: null`.
    await expect
      .poll(async () => (await f.run(w.team, runId)).user_entry_id, { interval: 25 })
      .toBe(entries.user);
    return { runId, entries };
  };
  const first = await answer("hello");
  return {
    w,
    author,
    reader,
    agentId,
    threadId,
    ws,
    answer,
    runId: first.runId,
    entries: first.entries,
  };
}

const rate = (p: Person, runId: string, body: Record<string, unknown>) =>
  as(p).put(`/v1/runs/${runId}/feedback`, body);
const clear = (p: Person, runId: string) => as(p).delete(`/v1/runs/${runId}/feedback`);
const mine = async (p: Person, threadId: string) => {
  const res = await as(p).get(`/v1/threads/${threadId}/feedback`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as {
    answers: {
      run_id: string;
      user_entry_id: string | null;
      feedback: Record<string, unknown> | null;
    }[];
  };
};

const holdAdmins = new Map<string, { placer: string; approver: string }>();

async function placeHold(teamId: string, userId: string | null): Promise<string> {
  const placer = await f.fx.person(`hp${randomUUID().slice(0, 4)}`);
  const approver = await f.fx.person(`ha${randomUUID().slice(0, 4)}`);
  for (const p of [placer, approver]) {
    await f.fx.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [p.id]);
  }
  const { rows } = await f.fx.admin.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
    [teamId, userId, placer.id],
  );
  const id = rows[0]?.id ?? "";
  await f.fx.admin.query(
    `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
    [id, approver.id],
  );
  holdAdmins.set(id, { placer: placer.id, approver: approver.id });
  return id;
}

async function releaseHold(id: string): Promise<void> {
  const admins = holdAdmins.get(id);
  if (!admins) throw new Error(`no hold ${id}`);
  await f.fx.admin.query(
    `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(),
       release_reason = 'closed' WHERE id = $1`,
    [id, admins.placer],
  );
  await f.fx.admin.query(
    `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
    [id, admins.approver],
  );
}

describe("rating answers (ac-1)", () => {
  it("rates, changes and clears an answer; one rating per run and member; survives a reload", async () => {
    const x = await world();
    const listed = await mine(x.author, x.threadId);
    expect(listed.answers).toEqual([
      { run_id: x.runId, user_entry_id: expect.any(String), feedback: null, eval_case_id: null },
    ]);

    const up = await rate(x.author, x.runId, { rating: "up", entry_id: x.entries.assistant });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    expect(up.json).toMatchObject({
      run_id: x.runId,
      thread_id: x.threadId,
      entry_id: x.entries.assistant,
      rating: "up",
      reasons: [],
      comment: null,
    });

    const down = await rate(x.author, x.runId, {
      rating: "down",
      reasons: ["wrong", "unsafe"],
      comment: "  It made the number up. ",
    });
    expect(down.status, JSON.stringify(down.json)).toBe(200);
    // A change without an entry keeps the stored one.
    expect(down.json).toMatchObject({
      rating: "down",
      reasons: ["wrong", "unsafe"],
      comment: "It made the number up.",
      entry_id: x.entries.assistant,
    });
    const rows = await f.fx.admin.query<Record<string, unknown>>(
      `SELECT user_id, agent_scope, agent_id, agent_version FROM answer_feedback WHERE team_id = $1`,
      [x.w.team],
    );
    expect(rows.rows).toEqual([
      { user_id: x.author.id, agent_scope: "team", agent_id: x.agentId, agent_version: 1 },
    ]);

    // A reload reads it back.
    expect((await mine(x.author, x.threadId)).answers[0]?.feedback).toMatchObject({
      rating: "down",
      comment: "It made the number up.",
    });

    expect((await clear(x.author, x.runId)).status).toBe(204);
    expect((await clear(x.author, x.runId)).status).toBe(204);
    expect((await mine(x.author, x.threadId)).answers[0]?.feedback).toBeNull();
    // Rating changes are not audited per click.
    expect((await f.auditActions(x.w.team)).filter((a) => a.includes("feedback"))).toEqual([]);
  });

  it("refuses what isn't a finished answer, a bad body, and another thread's entry", async () => {
    const x = await world();
    const bad = [
      { rating: "up", comment: "nice" },
      { rating: "up", reasons: ["wrong"] },
      { rating: "down", comment: "x".repeat(501) },
      { rating: "down", reasons: ["boring"] },
      { rating: "sideways" },
    ];
    for (const body of bad) {
      expect((await rate(x.author, x.runId, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await rate(x.author, randomUUID(), { rating: "up" })).json.code).toBe("run_not_found");
    expect((await rate(x.author, "not-a-uuid", { rating: "up" })).status).toBe(404);
    expect((await rate(x.author, x.runId, { rating: "up", entry_id: "nope" })).json.code).toBe(
      "entry_not_found",
    );
    // A run still going can't be rated yet.
    const running = await f.message(x.author, x.threadId, "again");
    await x.ws.started(running);
    const early = await rate(x.author, running, { rating: "up" });
    expect(early.status, JSON.stringify(early.json)).toBe(409);
    expect(early.json.code).toBe("run_not_ended");
  });
});

describe("who rates (ac-1)", () => {
  it("lets readers of a shared thread rate for themselves; nobody else sees or reaches it", async () => {
    const x = await world();
    const outsider = await f.member(x.w.team);
    // Private: the reader and the team admin can't rate (the same 404 as an unknown run).
    for (const p of [x.reader, x.w.owner]) {
      expect((await rate(p, x.runId, { rating: "up" })).status).toBe(404);
      expect((await as(p).get(`/v1/threads/${x.threadId}/feedback`)).status).toBe(404);
    }
    expect(
      (await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "team" })).status,
    ).toBe(200);
    expect((await rate(x.author, x.runId, { rating: "up" })).status).toBe(200);
    const theirs = await rate(x.reader, x.runId, {
      rating: "down",
      reasons: ["other"],
      comment: "reader's own note",
    });
    expect(theirs.status, JSON.stringify(theirs.json)).toBe(200);
    // Each sees only their own rating.
    expect((await mine(x.author, x.threadId)).answers[0]?.feedback).toMatchObject({ rating: "up" });
    expect((await mine(x.reader, x.threadId)).answers[0]?.feedback).toMatchObject({
      rating: "down",
      comment: "reader's own note",
    });
    expect((await mine(outsider, x.threadId)).answers[0]?.feedback).toBeNull();
    // Clearing touches the caller's row only.
    expect((await clear(outsider, x.runId)).status).toBe(204);
    expect((await mine(x.reader, x.threadId)).answers[0]?.feedback).not.toBeNull();

    // The share ends: the reader can't read or rate any more, but can still take theirs back.
    await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "private" });
    expect((await rate(x.reader, x.runId, { rating: "up" })).status).toBe(404);
    expect((await clear(x.reader, x.runId)).status).toBe(204);
    const left = await f.fx.admin.query(`SELECT user_id FROM answer_feedback WHERE team_id = $1`, [
      x.w.team,
    ]);
    expect(left.rows).toEqual([{ user_id: x.author.id }]);
  });

  it("lets a project-share reader rate, and nobody outside the project", async () => {
    const x = await world();
    const outsider = await f.member(x.w.team);
    const project = await as(x.w.owner).post("/v1/projects", {
      name: `P ${randomUUID().slice(0, 6)}`,
      members_mode: "selected",
      member_user_ids: [x.author.id, x.reader.id],
    });
    expect(project.status, JSON.stringify(project.json)).toBe(201);
    const moved = await as(x.author).post(`/v1/threads/${x.threadId}/move`, {
      project_id: project.json.id,
    });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    expect((await rate(x.reader, x.runId, { rating: "up" })).status).toBe(404);
    const shared = await as(x.author).post(`/v1/threads/${x.threadId}/share`, {
      visibility: "project",
    });
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);
    expect((await rate(x.reader, x.runId, { rating: "up" })).status).toBe(200);
    expect((await mine(x.reader, x.threadId)).answers[0]?.feedback).toMatchObject({ rating: "up" });
    expect((await rate(outsider, x.runId, { rating: "up" })).status).toBe(404);
    expect((await as(outsider).get(`/v1/threads/${x.threadId}/feedback`)).status).toBe(404);
  });

  it("never reaches another team's run", async () => {
    const x = await world();
    const y = await world();
    expect((await rate(x.author, y.runId, { rating: "up" })).status).toBe(404);
    expect((await as(x.author).get(`/v1/threads/${y.threadId}/feedback`)).status).toBe(404);
    expect((await clear(x.author, y.runId)).status).toBe(204);
  });

  it("takes no ratings in Trash and lists no answers there", async () => {
    const x = await world();
    expect((await as(x.author).delete(`/v1/threads/${x.threadId}`)).status).toBe(200);
    const res = await rate(x.author, x.runId, { rating: "up" });
    expect(res.json.code).toBe("thread_in_trash");
    expect((await mine(x.author, x.threadId)).answers).toEqual([]);
  });
});

/**
 * Ratings of `agentId` by `n` fresh members in `teamId`, written directly (one thread and ended
 * run each): enough raters for the totals without driving n sandboxes.
 */
async function seedRatings(
  teamId: string,
  agent: { scope: string; id: string; version: number | null },
  n: number,
  values: {
    rating: "up" | "down";
    reasons?: string[];
    model?: string | null;
    /** When it was rated (default 1: yesterday, a finished day the totals include). */
    daysAgo?: number;
  },
): Promise<string[]> {
  const raters: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const userId = randomUUID();
    await f.fx.admin.query(`INSERT INTO users (id, name, email) VALUES ($1, 'r', $2)`, [
      userId,
      `${userId}@rate.test`,
    ]);
    const thread = await f.fx.admin.query<{ id: string }>(
      `INSERT INTO threads (team_id, owner_user_id, title) VALUES ($1, $2, 't') RETURNING id`,
      [teamId, userId],
    );
    const threadId = thread.rows[0]?.id ?? "";
    const run = await f.fx.admin.query<{ id: string }>(
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, ended_at)
       VALUES ($1, $2, 'user', 'completed', now(), now()) RETURNING id`,
      [teamId, threadId],
    );
    await f.fx.admin.query(
      `INSERT INTO answer_feedback (team_id, thread_id, run_id, user_id, rating, reasons,
         agent_scope, agent_id, agent_version, model_alias, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10,
         now() - make_interval(days => $11::int), now() - make_interval(days => $11::int))`,
      [
        teamId,
        threadId,
        run.rows[0]?.id,
        userId,
        values.rating,
        `{${(values.reasons ?? []).join(",")}}`,
        agent.scope,
        agent.id,
        agent.version,
        values.model ?? null,
        values.daysAgo ?? 1,
      ],
    );
    raters.push(userId);
  }
  return raters;
}

const totals = async (p: Person, agentId: string, query = "") => {
  const res = await as(p).get(`/v1/agents/${agentId}/feedback${query}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res;
};

const WITHHELD = { enough: false, up: null, down: null, rate: null };

describe("totals for agent owners (ac-3)", () => {
  it("counts per version, model, reason and day over at least five other raters, with no content", async () => {
    const x = await world();
    await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "team" });
    await rate(x.author, x.runId, { rating: "down", reasons: ["wrong"], comment: "SECRET-1" });
    await rate(x.reader, x.runId, { rating: "down", reasons: ["wrong"], comment: "SECRET-2" });
    // Rated yesterday (today's ratings count once the day is over).
    await f.fx.admin.query(
      `UPDATE answer_feedback SET created_at = created_at - interval '1 day',
         updated_at = updated_at - interval '1 day' WHERE team_id = $1`,
      [x.w.team],
    );
    // Two raters: below the minimum, nothing but "not enough" shows.
    expect((await totals(x.w.owner, x.agentId)).json).toMatchObject({
      bucket: "day",
      min_raters: 5,
      totals: WITHHELD,
      versions: null,
      series: null,
    });

    const agent = { scope: "team", id: x.agentId, version: 1 };
    await seedRatings(x.w.team, agent, 5, { rating: "down", reasons: ["wrong"], model: "fast" });
    await seedRatings(x.w.team, agent, 5, { rating: "up", model: "smart" });
    const res = await totals(x.w.owner, x.agentId);
    expect(res.json).toMatchObject({
      totals: { enough: true, up: 5, down: 7, rate: 5 / 12 },
      versions: [
        {
          version: 1,
          up: 5,
          down: 7,
          reasons: { wrong: 7, unsafe: 0, too_slow: 0, ignored_instructions: 0, other: 0 },
          // The two real ratings (model unknown) are under five raters: no model breakdown.
          models: null,
        },
      ],
    });
    expect(res.json.series).toEqual([
      { start: expect.stringMatching(/T00:00:00\.000Z$/), up: 5, down: 7 },
    ]);
    for (const secret of ["SECRET", x.threadId, x.runId, x.author.id, x.reader.id]) {
      expect(res.text).not.toContain(secret);
    }
  });

  it("hides a whole breakdown when any of its cells is under five raters (no differencing)", async () => {
    const x = await world();
    const agent = { scope: "team", id: x.agentId, version: 1 };
    await seedRatings(x.w.team, agent, 5, { rating: "up", model: "smart", daysAgo: 2 });
    await seedRatings(x.w.team, agent, 5, { rating: "down", reasons: ["wrong"], model: "smart" });
    // One lone rater: another model, another reason, another day, another version.
    await seedRatings(x.w.team, { ...agent, version: 2 }, 1, {
      rating: "down",
      reasons: ["unsafe"],
      model: "fast",
      daysAgo: 3,
    });
    const res = (await totals(x.w.owner, x.agentId)).json;
    // The totals stand (11 raters), but no breakdown could leave the lone rating as a remainder.
    expect(res.totals).toEqual({ enough: true, up: 5, down: 6, rate: 5 / 11 });
    expect(res.versions).toBeNull();
    expect(res.series).toBeNull();
    // Without the lone rater's version and day, the version's own breakdowns still hide it.
    const y = await world();
    const solo = { scope: "team", id: y.agentId, version: 1 };
    await seedRatings(y.w.team, solo, 5, { rating: "down", reasons: ["wrong"], model: "smart" });
    await seedRatings(y.w.team, solo, 1, { rating: "down", reasons: ["unsafe"], model: "fast" });
    const one = (await totals(y.w.owner, y.agentId)).json;
    expect(one.totals).toMatchObject({ enough: true, down: 6 });
    expect(one.series).toEqual([{ start: expect.any(String), up: 0, down: 6 }]);
    expect(one.versions).toEqual([
      { version: 1, up: 0, down: 6, rate: 0, reasons: null, models: null },
    ]);
  });

  it("takes only the preset windows of finished days, so a new rating today reveals nothing", async () => {
    const x = await world();
    const agent = { scope: "team", id: x.agentId, version: 1 };
    await seedRatings(x.w.team, agent, 6, { rating: "up", daysAgo: 2 });
    await seedRatings(x.w.team, agent, 5, { rating: "down", daysAgo: 20 });
    const week = (await totals(x.w.owner, x.agentId, "?window=7")).json;
    expect(week).toMatchObject({ window_days: 7, totals: { enough: true, up: 6, down: 0 } });
    expect(Date.parse(week.to) - Date.parse(week.from)).toBe(7 * 86_400_000);
    expect(week.to).toMatch(/T00:00:00\.000Z$/);
    const month = (await totals(x.w.owner, x.agentId)).json;
    expect(month).toMatchObject({ window_days: 30, totals: { up: 6, down: 5 } });
    expect((await totals(x.w.owner, x.agentId, "?window=90")).json.totals).toEqual(month.totals);
    // Today's ratings don't count until the day is over.
    await seedRatings(x.w.team, agent, 1, { rating: "down", daysAgo: 0 });
    expect((await totals(x.w.owner, x.agentId)).json).toEqual(month);
    // No custom ranges, buckets or other windows.
    for (const q of [
      "?window=14",
      "?window=7&window=30",
      `?from=${new Date(Date.now() - 3 * 86_400_000).toISOString()}`,
      `?to=${new Date().toISOString()}`,
      "?bucket=day",
      "?window=30&from=2026-01-01T00:00:00Z",
    ]) {
      expect((await as(x.w.owner).get(`/v1/agents/${x.agentId}/feedback${q}`)).status, q).toBe(400);
    }
  });

  it("doesn't count the caller among the raters, and shows a one-rater agent nothing", async () => {
    const x = await world();
    await f.fx.admin.query(
      `UPDATE team_members SET role = 'builder' WHERE team_id = $1 AND user_id = $2`,
      [x.w.team, x.reader.id],
    );
    const own = await publishedAgent(x.reader);
    const agent = { scope: "team", id: own, version: 1 };
    // One other rater: withheld.
    await seedRatings(x.w.team, agent, 1, { rating: "down", reasons: ["unsafe"] });
    expect((await totals(x.reader, own)).json).toMatchObject({
      totals: WITHHELD,
      versions: null,
      series: null,
    });
    // Four others plus the owner's own rating: still four other raters.
    await seedRatings(x.w.team, agent, 3, { rating: "up" });
    const [mine] = await seedRatings(x.w.team, agent, 1, { rating: "up" });
    await f.fx.admin.query(
      `UPDATE answer_feedback SET user_id = $1 WHERE team_id = $2 AND user_id = $3`,
      [x.reader.id, x.w.team, mine],
    );
    expect((await totals(x.reader, own)).json.totals).toEqual(WITHHELD);
    // A fifth other rater: shown, the owner's own rating included in the numbers.
    await seedRatings(x.w.team, agent, 1, { rating: "up" });
    expect((await totals(x.reader, own)).json.totals).toEqual({
      enough: true,
      up: 5,
      down: 1,
      rate: 5 / 6,
    });
    expect((await totals(x.w.owner, own)).json.totals).toMatchObject({ enough: true, up: 5 });
  });

  it("is for owners and team admins: members, other builders and other teams are refused", async () => {
    const x = await world();
    await f.fx.admin.query(
      `UPDATE team_members SET role = 'builder' WHERE team_id = $1 AND user_id = $2`,
      [x.w.team, x.reader.id],
    );
    expect((await as(x.author).get(`/v1/agents/${x.agentId}/feedback`)).status).toBe(403);
    expect((await as(x.reader).get(`/v1/agents/${x.agentId}/feedback`)).status).toBe(403);
    expect((await as(x.w.owner).get(`/v1/agents/${x.agentId}/feedback`)).status).toBe(200);
    const other = await f.world();
    expect((await as(other.owner).get(`/v1/agents/${x.agentId}/feedback`)).status).toBe(404);
  });

  it("shows a personal agent's totals to its owner only, never to a team admin", async () => {
    const x = await world();
    const created = await as(x.author).post("/v1/agents", {
      scope: "personal",
      frontmatter: { name: "Mine" },
      prompt: "Mine.",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const id = created.json.agent.id as string;
    await seedRatings(x.w.team, { scope: "personal", id, version: null }, 5, { rating: "up" });
    expect((await totals(x.author, id)).json.totals).toMatchObject({ enough: true, up: 5 });
    // To the team admin someone else's personal agent doesn't exist.
    expect((await as(x.w.owner).get(`/v1/agents/${id}/feedback`)).status).toBe(404);
  });

  it("confines a gallery agent's totals to the active team, for its team admins", async () => {
    await seedGalleryAgents(f.fx.db, [GALLERY]);
    const x = await world();
    const y = await world();
    const list = await as(x.w.owner).get("/v1/agents?scope=gallery");
    const id = (list.json.agents as { id: string; slug: string }[]).find(
      (a) => a.slug === GALLERY.key,
    )?.id as string;
    expect(id).toBeDefined();
    const agent = { scope: "gallery", id, version: 1 };
    await seedRatings(x.w.team, agent, 5, { rating: "up" });
    await seedRatings(y.w.team, agent, 7, { rating: "down" });
    expect((await totals(x.w.owner, id)).json.totals).toMatchObject({ up: 5, down: 0 });
    expect((await totals(y.w.owner, id)).json.totals).toMatchObject({ up: 0, down: 7 });
    expect((await as(x.author).get(`/v1/agents/${id}/feedback`)).status).toBe(403);
  });
});

describe("ratings follow their thread (ac-4)", () => {
  it("are purged with the thread from Trash; a hold keeps them, silently", async () => {
    const x = await world();
    const y = await world();
    await rate(x.author, x.runId, { rating: "down", comment: "held note" });
    await rate(y.author, y.runId, { rating: "down", comment: "free note" });
    await placeHold(x.w.team, x.author.id);
    // Held and unheld members get the very same answers.
    const shape = (res: { status: number; json: unknown }) => {
      const body = res.json as Record<string, unknown> | null;
      return {
        status: res.status,
        body: body && { ...body, run_id: "-", thread_id: "-", entry_id: "-", updated_at: "-" },
      };
    };
    for (const body of [{ rating: "up" }, { rating: "down", reasons: ["other"] }]) {
      expect(shape(await rate(x.author, x.runId, body))).toEqual(
        shape(await rate(y.author, y.runId, body)),
      );
    }
    const cleared = [await clear(x.author, x.runId), await clear(y.author, y.runId)];
    expect(cleared.map((r) => [r.status, r.text])).toEqual([
      [204, ""],
      [204, ""],
    ]);
    expect((await mine(x.author, x.threadId)).answers[0]?.feedback).toBeNull();
    // The held member's earlier values are kept; the unheld one's are not.
    const kept = await f.fx.admin.query<{
      team_id: string;
      comment: string | null;
      change: string;
    }>(
      `SELECT team_id, comment, change FROM answer_feedback_history
        WHERE team_id = ANY($1::uuid[]) ORDER BY kept_at, change`,
      [[x.w.team, y.w.team]],
    );
    expect(kept.rows).toEqual([
      { team_id: x.w.team, comment: "held note", change: "changed" },
      { team_id: x.w.team, comment: null, change: "changed" },
      { team_id: x.w.team, comment: null, change: "cleared" },
    ]);
    for (const t of [x, y]) {
      expect((await as(t.author).delete(`/v1/threads/${t.threadId}`)).status).toBe(200);
      await f.fx.admin.query(
        `UPDATE threads SET deleted_at = now() - interval '31 days' WHERE team_id = $1 AND id = $2`,
        [t.w.team, t.threadId],
      );
    }
    await runRetentionPass({ db: f.fx.db, logger: pino({ level: "silent" }) });
    const threadsLeft = await f.fx.admin.query<{ team_id: string }>(
      `SELECT team_id FROM threads WHERE id = ANY($1::uuid[])`,
      [[x.threadId, y.threadId]],
    );
    expect(threadsLeft.rows).toEqual([{ team_id: x.w.team }]);
    const historyLeft = await f.fx.admin.query(
      `SELECT 1 FROM answer_feedback_history WHERE team_id = $1`,
      [x.w.team],
    );
    expect(historyLeft.rowCount).toBe(3);
  });

  it("answer a reader on a held owner's thread exactly as on an unheld one", async () => {
    const x = await world();
    const y = await world();
    for (const t of [x, y]) {
      await as(t.author).post(`/v1/threads/${t.threadId}/share`, { visibility: "team" });
      await rate(t.reader, t.runId, { rating: "down", comment: "reader note" });
    }
    await placeHold(x.w.team, x.author.id);
    const shape = (res: { status: number; json: unknown; text: string }) => {
      const body = res.json as Record<string, unknown> | null;
      return {
        status: res.status,
        body: body && { ...body, run_id: "-", thread_id: "-", entry_id: "-", updated_at: "-" },
        text: body ? undefined : res.text,
      };
    };
    for (const body of [
      { rating: "up" },
      { rating: "up" },
      { rating: "down", reasons: ["other"] },
    ]) {
      expect(shape(await rate(x.reader, x.runId, body))).toEqual(
        shape(await rate(y.reader, y.runId, body)),
      );
    }
    expect(shape(await clear(x.reader, x.runId))).toEqual(shape(await clear(y.reader, y.runId)));
    expect(shape(await as(x.reader).get(`/v1/threads/${x.threadId}/feedback`)).status).toBe(200);
    expect((await mine(x.reader, x.threadId)).answers[0]?.feedback).toBeNull();
    // The held thread's evidence is kept: the first comment, the later reason, the clear.
    const kept = await f.fx.admin.query<{ comment: string | null; change: string }>(
      `SELECT comment, change FROM answer_feedback_history WHERE team_id = $1 ORDER BY kept_at, change`,
      [x.w.team],
    );
    expect(kept.rows).toEqual([
      { comment: "reader note", change: "changed" },
      { comment: null, change: "changed" },
      { comment: null, change: "cleared" },
    ]);
  });

  it("keep a held reader's own comment on someone else's thread, silently", async () => {
    const x = await world();
    await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "team" });
    await rate(x.reader, x.runId, { rating: "down", comment: "reader's note" });
    await placeHold(x.w.team, x.reader.id);
    expect((await clear(x.reader, x.runId)).status).toBe(204);
    expect((await mine(x.reader, x.threadId)).answers[0]?.feedback).toBeNull();
    const kept = await f.fx.admin.query(
      `SELECT user_id, comment FROM answer_feedback_history WHERE team_id = $1`,
      [x.w.team],
    );
    expect(kept.rows).toEqual([{ user_id: x.reader.id, comment: "reader's note" }]);
  });

  it("purge what a hold kept once the hold is released", async () => {
    const x = await world();
    await rate(x.author, x.runId, { rating: "down", comment: "kept for the matter" });
    const hold = await placeHold(x.w.team, x.author.id);
    expect((await clear(x.author, x.runId)).status).toBe(204);
    const kept = () =>
      f.fx.admin.query(`SELECT 1 FROM answer_feedback_history WHERE team_id = $1`, [x.w.team]);
    const pass = () => runRetentionPass({ db: f.fx.db, logger: pino({ level: "silent" }) });
    // Still held: the pass keeps it.
    await pass();
    expect((await kept()).rowCount).toBe(1);
    await releaseHold(hold);
    const result = await pass();
    expect(result.teams.find((t) => t.teamId === x.w.team)).toMatchObject({
      feedbackHistory: { rows: 1 },
      failed: false,
    });
    expect((await kept()).rowCount).toBe(0);
    const audited = await f.fx.admin.query<{ target: unknown }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'retention.feedback_history_purged'`,
      [x.w.team],
    );
    expect(audited.rows).toEqual([{ target: { rows: 1 } }]);
  });

  it("are in the member's export with their comment, their own only", async () => {
    const x = await world();
    await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "team" });
    await rate(x.author, x.runId, { rating: "down", reasons: ["wrong"], comment: "author note" });
    await rate(x.reader, x.runId, { rating: "down", comment: "reader note" });
    const exported = async (p: Person) => {
      const res = await as(p).get("/v1/threads/export");
      expect(res.status).toBe(200);
      const files = unzipSync(res.bytes);
      return JSON.parse(strFromU8(files["feedback.json"] ?? new Uint8Array())) as {
        feedback: Record<string, unknown>[];
      };
    };
    expect((await exported(x.author)).feedback).toEqual([
      expect.objectContaining({
        run_id: x.runId,
        rating: "down",
        reasons: ["wrong"],
        comment: "author note",
      }),
    ]);
    // The reader's export holds their rating of the shared answer, not the author's.
    expect((await exported(x.reader)).feedback).toEqual([
      expect.objectContaining({ thread_id: x.threadId, comment: "reader note" }),
    ]);
  });
});

describe("Langfuse scores (ac-5)", () => {
  it("exports a score on the run's trace with ids and reasons, no comment, and deletes it on clear", async () => {
    const x = await world();
    sink.calls.length = 0;
    await rate(x.author, x.runId, {
      rating: "down",
      reasons: ["unsafe"],
      comment: "do not export",
    });
    const upserts = (await scores()).filter((c) => c.op === "upsert");
    expect(upserts).toHaveLength(1);
    const score = (upserts[0] as { score: TraceScore }).score;
    expect(score).toMatchObject({
      traceId: runTraceId(x.runId),
      name: "answer_feedback",
      dataType: "BOOLEAN",
      value: 0,
      metadata: {
        rating: "down",
        reasons: ["unsafe"],
        team_id: x.w.team,
        thread_id: x.threadId,
        run_id: x.runId,
        agent_scope: "team",
        agent_id: x.agentId,
        agent_version: 1,
      },
    });
    expect(JSON.stringify(score)).not.toContain("do not export");
    expect(score).not.toHaveProperty("comment");

    await rate(x.author, x.runId, { rating: "up" });
    await clear(x.author, x.runId);
    const calls = await scores();
    expect(calls.at(-1)).toEqual({ op: "remove", id: score.id });
    const ids = new Set(calls.map((c) => (c.op === "upsert" ? c.score.id : c.id)));
    expect(ids).toEqual(new Set([score.id]));
  });
});

describe("score export queue", () => {
  it("coalesces changes to one rating, survives a failing backend and drops past its bound", async () => {
    const x = await world();
    const second = await x.answer("second");
    await rate(x.author, x.runId, { rating: "up" });
    await rate(x.author, second.runId, { rating: "down" });
    const ids = (
      await f.fx.admin.query<{ id: string; run_id: string }>(
        `SELECT id, run_id FROM answer_feedback WHERE team_id = $1 ORDER BY run_id = $2 DESC`,
        [x.w.team, x.runId],
      )
    ).rows.map((r) => r.id);
    const [first, other] = ids as [string, string];
    const seen: string[] = [];
    let fail = true;
    const queue = new FeedbackScores({
      db: f.fx.db,
      captureContent: true,
      maxPending: 1,
      sink: {
        upsert: (score) => {
          seen.push(score.id);
          if (fail) {
            fail = false;
            return Promise.reject(new Error("backend down"));
          }
          return Promise.resolve();
        },
        remove: (id) => {
          seen.push(`-${id}`);
          return Promise.resolve();
        },
      },
    });
    // The first call fails (logged, dropped), and the queue goes on.
    queue.enqueue(x.w.team, first);
    await queue.idle();
    // A burst on one rating: one call in flight, the rest coalesce into one pending call; a second
    // rating while one is pending is over the bound of 1 and dropped.
    queue.enqueue(x.w.team, first);
    queue.enqueue(x.w.team, first);
    queue.enqueue(x.w.team, first);
    queue.enqueue(x.w.team, other);
    await queue.idle();
    expect(seen).toEqual([first, first, first]);
    // A rating that is gone is removed by its id.
    queue.enqueue(x.w.team, randomUUID());
    await queue.idle();
    expect(seen.at(-1)).toMatch(/^-/);
  });
});
