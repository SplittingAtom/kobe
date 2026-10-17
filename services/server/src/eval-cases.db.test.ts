import { randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { acceptedCases } from "./eval-cases/review.js";
import { purgeDepartedCasesInTx } from "./retention/eval-cases.js";
import { runRetentionPass } from "./retention/index.js";
import { RunFixture, type RunWorld } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-276: shared eval cases through the API. The conversation's owner shares a thumbs-down
 * answer after a preview (ac-1); the agent's owner lists, reads, accepts or dismisses it and
 * writes the expected behaviour, never seeing who shared it (ac-2); withdrawal, legal hold,
 * retention, offboarding and export (ac-3); nobody else reads cases (ac-4).
 */
const ANY = { "if-match": "*" };
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

const as = (p: Person) => f.on(0, p);

/** A builder (not a team admin) who owns and publishes a team agent; returns both. */
async function builderAgent(team: string): Promise<{ builder: Person; agentId: string }> {
  const builder = await f.member(team);
  await f.fx.admin.query(
    `UPDATE team_members SET role = 'builder' WHERE team_id = $1 AND user_id = $2`,
    [team, builder.id],
  );
  const b = as(builder);
  const created = await b.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: `Cased ${randomUUID().slice(0, 6)}` },
    prompt: "You answer.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const agentId = created.json.agent.id as string;
  const pub = await b.request("POST", `/v1/agents/${agentId}/publish`, {}, ANY);
  expect(pub.status, JSON.stringify(pub.json)).toBe(201);
  return { builder, agentId };
}

/**
 * A team (admin `w.owner`), a builder owning a team agent, a member (`author`) with two finished
 * answers on a thread pinned to it, and a reader; the second answer is rated down by the author.
 */
async function world() {
  const w = await f.world();
  const { builder, agentId } = await builderAgent(w.team);
  const author = await f.member(w.team);
  const reader = await f.member(w.team);
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
  const first = await answer("What is the capital of Australia?");
  const second = await answer("And its population?");
  const rated = await as(author).put(`/v1/runs/${second.runId}/feedback`, {
    rating: "down",
    reasons: ["wrong"],
    comment: "Made the number up.",
  });
  expect(rated.status, JSON.stringify(rated.json)).toBe(200);
  return { w, builder, agentId, author, reader, threadId, first, second, runId: second.runId };
}

type World = Awaited<ReturnType<typeof world>>;

const preview = (p: Person, runId: string, body: Record<string, unknown> = {}) =>
  as(p).post(`/v1/runs/${runId}/eval-case/preview`, body);
const share = (p: Person, runId: string, body: Record<string, unknown>) =>
  as(p).post(`/v1/runs/${runId}/eval-case`, body);

async function shareAsPreviewed(x: World, options: Record<string, unknown> = {}) {
  const seen = await preview(x.author, x.runId, options);
  expect(seen.status, JSON.stringify(seen.json)).toBe(200);
  const res = await share(x.author, x.runId, { ...options, digest: seen.json.digest });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.id as string;
}

/** A tool result under the answer's assistant entry, as Pi would write it. */
async function toolResult(x: World, callId: string, text: string) {
  await f.fx.admin.query(
    `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
     VALUES ($1, $2, $3, $4, 'message', $5::jsonb)`,
    [
      x.w.team,
      x.threadId,
      `tool-${callId}`,
      x.second.entries.assistant,
      JSON.stringify({
        message: {
          role: "toolResult",
          toolCallId: callId,
          toolName: "search",
          content: [{ type: "text", text }],
          isError: false,
        },
      }),
    ],
  );
}

async function attachment(x: World, name: string): Promise<string> {
  const { rows } = await f.fx.admin.query<{ id: string }>(
    `INSERT INTO files (team_id, user_id, thread_id, run_id, kind, name, size_bytes, sha256, mime_type, blob_ref)
     VALUES ($1, $2, $3, $4, 'upload', $5, 1234, $6, 'text/csv', $7) RETURNING id`,
    [x.w.team, x.author.id, x.threadId, x.runId, name, "a".repeat(64), `k/${randomUUID()}`],
  );
  return rows[0]?.id ?? "";
}

/**
 * The agent's owner sees a case only once its UTC day has ended (review S5): moves the team's
 * cases back a day (superuser, triggers bypassed, as time would).
 */
async function yesterday(team: string) {
  await longMembers(team);
  await f.fx.admin.query(`SET session_replication_role = replica`);
  await f.fx.admin.query(
    `UPDATE agent_eval_cases SET created_at = created_at - interval '1 day' WHERE team_id = $1`,
    [team],
  );
  await f.fx.admin.query(`SET session_replication_role = origin`);
}

/** A case counts only if shared during its sharer's membership (re-review R1): members since long. */
async function longMembers(team: string) {
  await f.fx.admin.query(
    `UPDATE team_members SET created_at = now() - interval '90 days' WHERE team_id = $1`,
    [team],
  );
}
const dayBefore = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

const caseRows = async (team: string) =>
  (
    await f.fx.admin.query<{ id: string; user_id: string; status: string }>(
      `SELECT id, user_id, status FROM agent_eval_cases WHERE team_id = $1 ORDER BY created_at`,
      [team],
    )
  ).rows;

describe("sharing a thumbs down after a preview (ac-1)", () => {
  it("previews exactly what is shared, adds nothing unticked, and stores nothing until the share", async () => {
    const x = await world();
    await toolResult(x, "call-1", "Population: 467,000 (2021 census)");
    const fileId = await attachment(x, "figures.csv");
    const bare = await preview(x.author, x.runId);
    expect(bare.status, JSON.stringify(bare.json)).toBe(200);
    expect(bare.json).toMatchObject({
      run_id: x.runId,
      agent: { scope: "team", id: x.agentId, version: 1 },
      content: {
        prompt: "And its population?",
        answer: "re: And its population?",
        earlier: [],
        tool_outputs: [],
        attachments: [],
        reasons: ["wrong"],
        comment: "Made the number up.",
        truncated: false,
      },
      available: {
        earlier_exchanges: 1,
        tool_outputs: [{ id: "call-1", tool: "search", is_error: false }],
        attachments: [{ id: fileId, name: "figures.csv", mime_type: "text/csv", size_bytes: 1234 }],
      },
      shared_case_id: null,
    });
    expect(bare.json.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await caseRows(x.w.team)).toEqual([]);

    const ticked = { earlier_exchanges: 1, tool_output_ids: ["call-1"], attachment_ids: [fileId] };
    const full = await preview(x.author, x.runId, ticked);
    expect(full.json.content).toMatchObject({
      earlier: [
        { role: "user", text: "What is the capital of Australia?" },
        { role: "assistant", text: "re: What is the capital of Australia?" },
      ],
      tool_outputs: [
        { tool: "search", text: "Population: 467,000 (2021 census)", is_error: false },
      ],
      attachments: [{ name: "figures.csv", mime_type: "text/csv", size_bytes: 1234 }],
    });
    expect(full.json.digest).not.toBe(bare.json.digest);
    // An id the answer doesn't have is refused, not ignored.
    expect((await preview(x.author, x.runId, { tool_output_ids: ["nope"] })).status).toBe(400);

    // The share needs the digest of what was previewed with the same options.
    expect((await share(x.author, x.runId, ticked)).status).toBe(400);
    const stale = await share(x.author, x.runId, { ...ticked, digest: bare.json.digest });
    expect(stale.json.code).toBe("preview_stale");
    expect(await caseRows(x.w.team)).toEqual([]);
    const shared = await share(x.author, x.runId, { ...ticked, digest: full.json.digest });
    expect(shared.status, JSON.stringify(shared.json)).toBe(201);
    expect(shared.json.content).toEqual(full.json.content);
    expect(shared.json.status).toBe("open");
    expect(await caseRows(x.w.team)).toEqual([
      { id: shared.json.id, user_id: x.author.id, status: "open" },
    ]);
    // Once, per rating; the chat learns it from the thread's feedback.
    const again = await share(x.author, x.runId, { ...ticked, digest: full.json.digest });
    expect(again.json.code).toBe("already_shared");
    expect((await preview(x.author, x.runId)).json.shared_case_id).toBe(shared.json.id);
    const listed = await as(x.author).get(`/v1/threads/${x.threadId}/feedback`);
    expect(
      (listed.json.answers as { run_id: string; eval_case_id: string | null }[]).map((a) => [
        a.run_id,
        a.eval_case_id,
      ]),
    ).toEqual([
      [x.first.runId, null],
      [x.runId, shared.json.id],
    ]);
    // Sharing is not audited (the audit log would name the sharer to team admins).
    expect((await f.auditActions(x.w.team)).filter((a) => a.includes("eval_case"))).toEqual([]);
  });

  it("refuses a changed rating since the preview", async () => {
    const x = await world();
    const seen = await preview(x.author, x.runId);
    await as(x.author).put(`/v1/runs/${x.runId}/feedback`, {
      rating: "down",
      reasons: ["wrong", "unsafe"],
      comment: "Worse than I said.",
    });
    expect((await share(x.author, x.runId, { digest: seen.json.digest })).json.code).toBe(
      "preview_stale",
    );
  });

  it("shares only the owner's own thumbs down on their own conversation", async () => {
    const x = await world();
    // Thumbs up, no rating, a reader's thumbs down on a shared thread: not shareable.
    expect((await preview(x.author, x.first.runId)).json.code).toBe("not_shareable");
    await as(x.author).put(`/v1/runs/${x.first.runId}/feedback`, { rating: "up" });
    expect((await preview(x.author, x.first.runId)).json.code).toBe("not_shareable");
    await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "team" });
    await as(x.reader).put(`/v1/runs/${x.runId}/feedback`, { rating: "down" });
    expect((await preview(x.reader, x.runId)).json.code).toBe("not_shareable");
    // Another team's run, and nonsense ids: the same 404.
    const y = await world();
    expect((await preview(x.author, y.runId)).status).toBe(404);
    expect((await preview(x.author, "not-a-uuid")).status).toBe(404);
    // A conversation in Trash.
    expect((await as(x.author).delete(`/v1/threads/${x.threadId}`)).status).toBe(200);
    expect((await preview(x.author, x.runId)).json.code).toBe("thread_unavailable");
  });
});

describe("own words only (review B1)", () => {
  it("never shares another member's prompts: not as a project reader, not through a fork", async () => {
    const x = await world();
    const bob = x.reader;
    const project = await as(x.w.owner).post("/v1/projects", {
      name: `P ${randomUUID().slice(0, 6)}`,
      members_mode: "selected",
      member_user_ids: [x.author.id, bob.id],
    });
    expect(project.status, JSON.stringify(project.json)).toBe(201);
    const moved = await as(x.author).post(`/v1/threads/${x.threadId}/move`, {
      project_id: project.json.id,
    });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    expect(
      (await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "project" }))
        .status,
    ).toBe(200);
    // A project reader rates the author's answer for themselves, but can't share it.
    expect((await as(bob).put(`/v1/runs/${x.runId}/feedback`, { rating: "down" })).status).toBe(
      200,
    );
    expect((await preview(bob, x.runId)).json.code).toBe("not_shareable");

    // Bob forks the author's conversation and continues it himself.
    const forked = await as(bob).post(`/v1/threads/${x.threadId}/fork`, {
      entry_id: x.second.entries.assistant,
    });
    expect(forked.status, JSON.stringify(forked.json)).toBe(201);
    const forkId = forked.json.thread_id as string;
    const bobWs = await f.connect(
      { team: x.w.team, owner: bob, target: { teamId: x.w.team, userId: bob.id } },
      0,
    );
    const ask = async (text: string) => {
      const runId = await f.message(bob, forkId, text);
      const start = await bobWs.started(runId);
      bobWs.reply(start, `re: ${text}`);
      await bobWs.acked(runId);
      await f.until(x.w.team, runId, "completed");
      expect((await as(bob).put(`/v1/runs/${runId}/feedback`, { rating: "down" })).status).toBe(
        200,
      );
      return runId;
    };
    const first = await ask("Bob's first question");
    // The fork's inherited exchanges are the author's: none can be added.
    const one = await preview(bob, first, { earlier_exchanges: 2 });
    expect(one.status, JSON.stringify(one.json)).toBe(200);
    expect(one.json.available.earlier_exchanges).toBe(0);
    expect(one.json.content.earlier).toEqual([]);
    const second = await ask("Bob's second question");
    const two = await preview(bob, second, { earlier_exchanges: 2 });
    expect(two.json.available.earlier_exchanges).toBe(1);
    expect(two.json.content.earlier).toEqual([
      { role: "user", text: "Bob's first question" },
      { role: "assistant", text: "re: Bob's first question" },
    ]);
    for (const text of [JSON.stringify(one.json), JSON.stringify(two.json)]) {
      expect(text).not.toContain("capital of Australia");
      expect(text).not.toContain("And its population?");
    }
  });
});

describe("the agent owner's review (ac-2)", () => {
  it("lists and reads cases without the sharer, accepts with an expected behaviour, dismisses", async () => {
    const x = await world();
    const id = await shareAsPreviewed(x);
    const owner = as(x.builder);
    // Shared today: the owner sees it only once the day is over (no timing, review S5).
    expect((await owner.get(`/v1/agents/${x.agentId}/eval-cases`)).json.cases).toEqual([]);
    expect((await owner.get(`/v1/agents/${x.agentId}/eval-cases/${id}`)).status).toBe(404);
    await yesterday(x.w.team);
    const list = await owner.get(`/v1/agents/${x.agentId}/eval-cases`);
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json).toEqual({
      agent_id: x.agentId,
      accepted: 0,
      max_accepted: 20,
      cases: [
        {
          id,
          status: "open",
          agent_version: 1,
          reasons: ["wrong"],
          prompt_excerpt: "And its population?",
          shared_on: dayBefore(),
          expected_behaviour: null,
          reviewed_at: null,
        },
      ],
    });
    const detail = await owner.get(`/v1/agents/${x.agentId}/eval-cases/${id}`);
    expect(detail.json.content.answer).toBe("re: And its population?");
    // Nothing in either answer names the sharer.
    for (const body of [list.text, detail.text]) {
      expect(body).not.toContain(x.author.id);
      expect(body).not.toContain(x.author.email);
    }
    const path = `/v1/agents/${x.agentId}/eval-cases/${id}`;
    expect((await owner.patch(path, { status: "accepted" })).json.code).toBe(
      "expected_behaviour_required",
    );
    const accepted = await owner.patch(path, {
      status: "accepted",
      expected_behaviour: "Say it doesn't know the current figure and point to the census.",
    });
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    expect(accepted.json).toMatchObject({ status: "accepted", reviewed_at: expect.any(String) });
    expect((await owner.patch(path, { expected_behaviour: null })).json.code).toBe(
      "expected_behaviour_required",
    );
    expect((await owner.get(`/v1/agents/${x.agentId}/eval-cases`)).json.accepted).toBe(1);
    expect((await owner.patch(path, { status: "dismissed" })).json.status).toBe("dismissed");
    const audited = await f.fx.admin.query<{ target: unknown }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'agent.eval_case.reviewed' ORDER BY seq`,
      [x.w.team],
    );
    expect(audited.rows.map((r) => r.target)).toEqual([
      { agentId: x.agentId, scope: "team", caseId: id, status: "accepted" },
      { agentId: x.agentId, scope: "team", caseId: id, status: "dismissed" },
    ]);
    // The sharer sees the status of their own case.
    expect((await as(x.author).get("/v1/eval-cases")).json.cases).toEqual([
      expect.objectContaining({ id, status: "dismissed" }),
    ]);
    expect((await owner.get(`/v1/agents/${x.agentId}/eval-cases/${randomUUID()}`)).status).toBe(
      404,
    );
  });

  it("caps the accepted cases per agent", async () => {
    const x = await world();
    const id = await shareAsPreviewed(x);
    await yesterday(x.w.team);
    await f.fx.admin.query(
      `INSERT INTO agent_eval_cases (team_id, user_id, agent_scope, agent_id, agent_version, content, status, expected_behaviour, reviewed_at, created_at)
       SELECT $1, $2, 'team', $3, 1, '{"prompt":"p","answer":"a","reasons":[]}', 'accepted', 'x', now(), now() - interval '1 day'
         FROM generate_series(1, 20)`,
      [x.w.team, x.reader.id, x.agentId],
    );
    const res = await as(x.builder).patch(`/v1/agents/${x.agentId}/eval-cases/${id}`, {
      status: "accepted",
      expected_behaviour: "Cite it.",
    });
    expect(res.json.code).toBe("case_limit");
  });
});

describe("withdrawal, holds, retention, offboarding, export (ac-3)", () => {
  it("deletes the copy on withdrawal: the member's own only, always 204", async () => {
    const x = await world();
    const id = await shareAsPreviewed(x);
    expect((await as(x.reader).delete(`/v1/eval-cases/${id}`)).status).toBe(204);
    expect((await as(x.builder).delete(`/v1/eval-cases/${id}`)).status).toBe(204);
    expect(await caseRows(x.w.team)).toHaveLength(1);
    expect((await as(x.author).delete(`/v1/eval-cases/${id}`)).status).toBe(204);
    expect((await as(x.author).delete(`/v1/eval-cases/${id}`)).status).toBe(204);
    expect(await caseRows(x.w.team)).toEqual([]);
    expect((await as(x.builder).get(`/v1/agents/${x.agentId}/eval-cases`)).json.cases).toEqual([]);
    expect((await as(x.author).get("/v1/eval-cases")).json.cases).toEqual([]);
    // Withdrawn: the answer can be shared again.
    expect((await preview(x.author, x.runId)).json.shared_case_id).toBeNull();
  });

  it("lists and withdraws a case after its rating was cleared (review S6)", async () => {
    const x = await world();
    const id = await shareAsPreviewed(x);
    expect((await as(x.author).delete(`/v1/runs/${x.runId}/feedback`)).status).toBe(204);
    const listed = await as(x.author).get(`/v1/threads/${x.threadId}/feedback`);
    expect(listed.json.answers.at(-1).eval_case_id).toBeNull();
    // The member's own list still has it, and withdrawing deletes it.
    expect((await as(x.author).get("/v1/eval-cases")).json.cases).toEqual([
      expect.objectContaining({ id, status: "open" }),
    ]);
    expect((await as(x.author).delete(`/v1/eval-cases/${id}`)).status).toBe(204);
    expect(await caseRows(x.w.team)).toEqual([]);
  });

  it("answers a held member's withdrawal like anyone's, keeps the copy and purges it after the release", async () => {
    const x = await world();
    const y = await world();
    const held = await shareAsPreviewed(x);
    const free = await shareAsPreviewed(y);
    const hold = await placeHold(x.w.team, x.author.id);
    const a = await as(x.author).delete(`/v1/eval-cases/${held}`);
    const b = await as(y.author).delete(`/v1/eval-cases/${free}`);
    expect([a.status, a.text]).toEqual([b.status, b.text]);
    expect((await as(x.author).get("/v1/eval-cases")).json.cases).toEqual([]);
    expect((await as(x.builder).get(`/v1/agents/${x.agentId}/eval-cases`)).json.cases).toEqual([]);
    const kept = () =>
      f.fx.admin.query(`SELECT case_id FROM agent_eval_case_history WHERE team_id = $1`, [
        x.w.team,
      ]);
    expect((await kept()).rows).toEqual([{ case_id: held }]);
    const pass = () => runRetentionPass({ db: f.fx.db, logger: pino({ level: "silent" }) });
    await pass();
    expect((await kept()).rowCount).toBe(1);
    await releaseHold(hold);
    const result = await pass();
    expect(result.teams.find((t) => t.teamId === x.w.team)).toMatchObject({
      evalCases: { cases: 0, kept: 1 },
      failed: false,
    });
    expect((await kept()).rowCount).toBe(0);
  });

  it("survives the conversation, and goes once past the team's retention window unless held", async () => {
    const x = await world();
    const y = await world();
    const old = await shareAsPreviewed(x);
    const kept = await shareAsPreviewed(y);
    await yesterday(x.w.team);
    // Deleted for good: the case is a copy and stays.
    await as(x.author).delete(`/v1/threads/${x.threadId}`);
    await f.fx.admin.query(
      `UPDATE threads SET deleted_at = now() - interval '31 days' WHERE team_id = $1 AND id = $2`,
      [x.w.team, x.threadId],
    );
    const pass = () => runRetentionPass({ db: f.fx.db, logger: pino({ level: "silent" }) });
    await pass();
    expect(
      (await f.fx.admin.query(`SELECT 1 FROM threads WHERE id = $1`, [x.threadId])).rowCount,
    ).toBe(0);
    expect(await caseRows(x.w.team)).toHaveLength(1);
    expect((await as(x.builder).get(`/v1/agents/${x.agentId}/eval-cases/${old}`)).status).toBe(200);
    // A 30-day window: both cases are shared 31 days ago; only the held member's stays.
    for (const t of [x, y]) {
      await longMembers(t.w.team);
      await f.fx.admin.query(
        `INSERT INTO team_retention (team_id, period, updated_by) VALUES ($1, '30d', $2)`,
        [t.w.team, t.w.owner.id],
      );
      await f.fx.admin.query(`SET session_replication_role = replica`);
      await f.fx.admin.query(
        `UPDATE agent_eval_cases SET created_at = now() - interval '31 days' WHERE team_id = $1`,
        [t.w.team],
      );
      await f.fx.admin.query(`SET session_replication_role = origin`);
    }
    const hold = await placeHold(y.w.team, y.author.id);
    await pass();
    expect(await caseRows(x.w.team)).toEqual([]);
    expect(await caseRows(y.w.team)).toHaveLength(1);
    // The held case past the window looks purged everywhere, so nothing shows the hold (S3):
    // not to the agent's owner, not in the gate, not to the sharer, not in the export.
    const owner = as(y.builder);
    expect((await owner.get(`/v1/agents/${y.agentId}/eval-cases`)).json.cases).toEqual([]);
    expect((await owner.get(`/v1/agents/${y.agentId}/eval-cases/${kept}`)).status).toBe(404);
    expect((await as(y.author).get("/v1/eval-cases")).json.cases).toEqual([]);
    await f.fx.admin.query(
      `UPDATE agent_eval_cases SET status = 'accepted', expected_behaviour = 'x', reviewed_at = now() WHERE team_id = $1`,
      [y.w.team],
    );
    expect(
      await withTeam(f.fx.db, y.w.team, (tx) =>
        acceptedCases(tx, { teamId: y.w.team, agentId: y.agentId, scope: "team" }),
      ),
    ).toEqual([]);
    const exported = unzipSync((await as(y.author).get("/v1/threads/export")).bytes);
    expect(JSON.parse(strFromU8(exported["eval-cases.json"] ?? new Uint8Array())).cases).toEqual(
      [],
    );
    const audited = await f.fx.admin.query<{ target: unknown }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'retention.eval_cases_purged'`,
      [x.w.team],
    );
    expect(audited.rows).toEqual([{ target: { reason: "retention", rows: 1 } }]);
    // Once skipped, it stays looking purged even if the team keeps everything again (R1).
    await f.fx.admin.query(`UPDATE team_retention SET period = 'forever' WHERE team_id = $1`, [
      y.w.team,
    ]);
    expect((await owner.get(`/v1/agents/${y.agentId}/eval-cases`)).json.cases).toEqual([]);
    expect((await owner.get(`/v1/agents/${y.agentId}/eval-cases/${kept}`)).status).toBe(404);
    expect((await as(y.author).get("/v1/eval-cases")).json.cases).toEqual([]);
    expect(
      await withTeam(f.fx.db, y.w.team, (tx) =>
        acceptedCases(tx, { teamId: y.w.team, agentId: y.agentId, scope: "team" }),
      ),
    ).toEqual([]);
    await releaseHold(hold);
  });

  it("never brings back a case shared before the sharer's current membership (R1)", async () => {
    const x = await world();
    const id = await shareAsPreviewed(x);
    await yesterday(x.w.team);
    const owner = as(x.builder);
    expect((await owner.get(`/v1/agents/${x.agentId}/eval-cases/${id}`)).status).toBe(200);
    // The sharer leaves (the case is hidden, as their offboarding would purge it) and rejoins.
    await f.fx.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      x.w.team,
      x.author.id,
    ]);
    expect((await owner.get(`/v1/agents/${x.agentId}/eval-cases/${id}`)).status).toBe(404);
    await f.fx.addMember(x.w.team, x.author);
    expect((await owner.get(`/v1/agents/${x.agentId}/eval-cases`)).json.cases).toEqual([]);
    expect((await owner.get(`/v1/agents/${x.agentId}/eval-cases/${id}`)).status).toBe(404);
    expect((await as(x.author).get("/v1/eval-cases")).json.cases).toEqual([]);
  });

  it("goes with a departed member's data at offboarding, unless held", async () => {
    const x = await world();
    await shareAsPreviewed(x);
    const purge = () =>
      withTeam(f.fx.db, x.w.team, (tx) => purgeDepartedCasesInTx(tx, x.w.team, x.author.id));
    const hold = await placeHold(x.w.team, x.author.id);
    expect(await purge()).toBe(0);
    await releaseHold(hold);
    expect(await purge()).toBe(1);
    expect(await caseRows(x.w.team)).toEqual([]);
    // No audit row names the departed sharer or counts their cases (review S4).
    const rows = await f.fx.admin.query(
      `SELECT 1 FROM audit_log WHERE team_id = $1 AND action = 'retention.eval_cases_purged'`,
      [x.w.team],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("is in the sharer's export, nobody else's", async () => {
    const x = await world();
    const id = await shareAsPreviewed(x);
    const exported = async (p: Person) => {
      const res = await as(p).get("/v1/threads/export");
      expect(res.status).toBe(200);
      const files = unzipSync(res.bytes);
      return JSON.parse(strFromU8(files["eval-cases.json"] ?? new Uint8Array())) as {
        cases: Record<string, unknown>[];
      };
    };
    expect((await exported(x.author)).cases).toEqual([
      expect.objectContaining({
        id,
        status: "open",
        agent: { scope: "team", id: x.agentId, version: 1 },
        content: expect.objectContaining({ prompt: "And its population?" }),
      }),
    ]);
    expect((await exported(x.builder)).cases).toEqual([]);
  });
});

describe("who reads cases (ac-4)", () => {
  it("is the agent's owner only: members, other builders, team admins and other teams are refused", async () => {
    const x = await world();
    const id = await shareAsPreviewed(x);
    await yesterday(x.w.team);
    const otherBuilder = await f.member(x.w.team);
    await f.fx.admin.query(
      `UPDATE team_members SET role = 'builder' WHERE team_id = $1 AND user_id = $2`,
      [x.w.team, otherBuilder.id],
    );
    const paths = [
      `/v1/agents/${x.agentId}/eval-cases`,
      `/v1/agents/${x.agentId}/eval-cases/${id}`,
    ];
    for (const p of [x.author, x.reader, otherBuilder, x.w.owner]) {
      for (const path of paths) {
        const res = await as(p).get(path);
        expect(res.status, `${p.id} ${path}`).toBe(403);
        expect(res.text).not.toContain("population");
      }
      const patched = await as(p).patch(paths[1] ?? "", { status: "dismissed" });
      expect(patched.status).toBe(403);
    }
    // Another team doesn't see the agent at all.
    const other = await f.world();
    for (const path of paths) expect((await as(other.owner).get(path)).status).toBe(404);
    // An install admin with no membership has no team route at all.
    const siteAdmin = await f.fx.person(`sa${randomUUID().slice(0, 4)}`);
    await f.fx.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [
      siteAdmin.id,
    ]);
    for (const path of paths) expect((await as(siteAdmin).get(path)).status).toBeGreaterThan(399);
    // The owner still reads it; the member's list shows only their own.
    expect((await as(x.builder).get(paths[1] ?? "")).status).toBe(200);
    expect((await as(x.reader).get("/v1/eval-cases")).json.cases).toEqual([]);
    // The owner who can no longer build loses access too.
    await f.fx.admin.query(
      `UPDATE team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2`,
      [x.w.team, x.builder.id],
    );
    for (const path of paths) expect((await as(x.builder).get(path)).status).toBe(403);
  });

  it("shows a personal agent's cases to its owner, never to a team admin", async () => {
    const w = await f.world();
    const author = await f.member(w.team);
    const created = await as(author).post("/v1/agents", {
      scope: "personal",
      frontmatter: { name: "Mine" },
      prompt: "Mine.",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const agentId = created.json.agent.id as string;
    await longMembers(w.team);
    await f.fx.admin.query(
      `INSERT INTO agent_eval_cases (team_id, user_id, agent_scope, agent_id, content, created_at)
       VALUES ($1, $2, 'personal', $3, '{"prompt":"p","answer":"a","reasons":[]}', now() - interval '1 day')`,
      [w.team, author.id, agentId],
    );
    expect((await as(author).get(`/v1/agents/${agentId}/eval-cases`)).json.cases).toHaveLength(1);
    expect((await as(w.owner).get(`/v1/agents/${agentId}/eval-cases`)).status).toBe(404);
  });
});

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
