import { randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTraceId } from "@kobe/protocol";
import type { ScoreSink, TraceScore } from "@kobe/telemetry";
import { FeedbackScores } from "./feedback/scores.js";
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
  return id;
}

describe("rating answers (ac-1)", () => {
  it("rates, changes and clears an answer; one rating per run and member; survives a reload", async () => {
    const x = await world();
    const listed = await mine(x.author, x.threadId);
    expect(listed.answers).toEqual([
      { run_id: x.runId, user_entry_id: expect.any(String), feedback: null },
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

describe("totals for agent owners (ac-3)", () => {
  it("counts per version, model and reason, for owners and team admins only, with no content", async () => {
    const x = await world();
    await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "team" });
    const second = await x.answer("second");
    await rate(x.author, x.runId, {
      rating: "down",
      reasons: ["wrong", "too_slow"],
      comment: "SECRET-1",
    });
    await rate(x.reader, x.runId, { rating: "down", reasons: ["wrong"], comment: "SECRET-2" });
    await rate(x.author, second.runId, { rating: "up" });

    const res = await as(x.w.owner).get(`/v1/agents/${x.agentId}/feedback`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({
      agent_id: x.agentId,
      bucket: "day",
      totals: { up: 1, down: 2, rate: 1 / 3 },
      versions: [
        {
          version: 1,
          up: 1,
          down: 2,
          reasons: { wrong: 2, too_slow: 1, unsafe: 0, ignored_instructions: 0, other: 0 },
          models: [{ model: null, up: 1, down: 2 }],
        },
      ],
    });
    expect(res.json.series).toHaveLength(1);
    // Counts only: no comment, thread, run, entry or member is reachable.
    for (const secret of ["SECRET", x.threadId, x.runId, second.runId, x.author.id, x.reader.id]) {
      expect(res.text).not.toContain(secret);
    }

    // A plain member and a builder who doesn't own the agent are refused; its builder-owner reads.
    await f.fx.admin.query(
      `UPDATE team_members SET role = 'builder' WHERE team_id = $1 AND user_id = $2`,
      [x.w.team, x.reader.id],
    );
    expect((await as(x.author).get(`/v1/agents/${x.agentId}/feedback`)).status).toBe(403);
    expect((await as(x.reader).get(`/v1/agents/${x.agentId}/feedback`)).status).toBe(403);
    const own = await publishedAgent(x.reader);
    expect((await as(x.reader).get(`/v1/agents/${own}/feedback`)).json.totals).toEqual({
      up: 0,
      down: 0,
      rate: null,
    });
    // Another team's admin doesn't see the agent at all.
    const other = await f.world();
    expect((await as(other.owner).get(`/v1/agents/${x.agentId}/feedback`)).status).toBe(404);
    // A bad range is a 400.
    expect(
      (await as(x.w.owner).get(`/v1/agents/${x.agentId}/feedback?from=yesterday`)).status,
    ).toBe(400);
  });
});

describe("ratings follow their thread (ac-4)", () => {
  it("are purged with the thread from Trash, and kept with it under a legal hold", async () => {
    const x = await world();
    const y = await world();
    await rate(x.author, x.runId, { rating: "down", comment: "held note" });
    await rate(y.author, y.runId, { rating: "up" });
    const hold = await placeHold(x.w.team, x.author.id);
    // Under the hold the rating can be neither changed nor cleared.
    expect((await rate(x.author, x.runId, { rating: "up" })).json.code).toBe("legal_hold");
    expect((await clear(x.author, x.runId)).json.code).toBe("legal_hold");
    for (const t of [x, y]) {
      expect((await as(t.author).delete(`/v1/threads/${t.threadId}`)).status).toBe(200);
      await f.fx.admin.query(
        `UPDATE threads SET deleted_at = now() - interval '31 days' WHERE team_id = $1 AND id = $2`,
        [t.w.team, t.threadId],
      );
    }
    await runRetentionPass({ db: f.fx.db, logger: pino({ level: "silent" }) });
    const left = await f.fx.admin.query<{ team_id: string }>(
      `SELECT team_id FROM answer_feedback WHERE team_id = ANY($1::uuid[])`,
      [[x.w.team, y.w.team]],
    );
    expect(left.rows).toEqual([{ team_id: x.w.team }]);
    expect(hold).not.toBe("");
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
