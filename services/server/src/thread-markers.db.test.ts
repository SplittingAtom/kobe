import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { threadMarkersSchema } from "./routes/thread-markers.js";
import { RunFixture } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * `GET /v1/threads/{id}/markers` (KOBE-209, CE12/CE16): what the chat marks inline that is not in
 * the entry tree: runs that ended interrupted or budget-stopped, and the asker's decided approvals.
 * Visible like the thread; approvals only to the run's user (as `GET /v1/approvals`).
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

const as = (p: Person) => f.on(0, p);

async function endRun(team: string, runId: string, status: string, userEntryId: string | null) {
  await f.fx.admin.query(
    `UPDATE runs SET status = $3::run_status, queue_pos = NULL, ended_at = now(),
                    user_entry_id = $4::text
      WHERE team_id = $1 AND id = $2`,
    [team, runId, status, userEntryId],
  );
}

async function approval(
  w: { team: string },
  run: { runId: string; threadId: string; userId: string },
  toolCallId: string,
  status: string,
  cause: string | null,
) {
  await f.fx.admin.query(
    `INSERT INTO approvals (team_id, id, run_id, thread_id, user_id, connection_id, tool_call_id,
                            tool, input_canonical, risk, reasons, status, cause, decided_at,
                            decided_by, expires_at, token_kid, token_expires_at, input_hmac)
     VALUES ($1, $2, $3, $4, $5, gen_random_uuid(), $6, 'bash', '{"secret":"x"}', 'write', '[]',
             $7::approval_status, $8::text, CASE WHEN $7::text = 'pending' THEN NULL ELSE now() END,
             CASE WHEN $7::text IN ('allowed', 'denied') THEN $5::uuid END,
             now() + interval '1 hour',
             CASE WHEN $7::text = 'allowed' THEN 'k1' END,
             CASE WHEN $7::text = 'allowed' THEN now() + interval '1 hour' END,
             CASE WHEN $7::text = 'allowed' THEN repeat('a', 43) END)`,
    [w.team, randomUUID(), run.runId, run.threadId, run.userId, toolCallId, status, cause],
  );
}

describe("GET /v1/threads/{id}/markers", () => {
  it("lists interrupted and budget-stopped runs and the owner's decided approvals", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    expect((await as(w.owner).get(`/v1/threads/${threadId}/markers`)).json).toEqual({
      runs: [],
      approvals: [],
    });

    const first = await f.message(w.owner, threadId, "first");
    await endRun(w.team, first, "interrupted", "e-1");
    const second = await f.message(w.owner, threadId, "second");
    await endRun(w.team, second, "budget_stopped", null);
    const third = await f.message(w.owner, threadId, "third");
    await endRun(w.team, third, "completed", "e-3");
    const run = { runId: first, threadId, userId: w.owner.id };
    await approval(w, run, "tc-allow", "allowed", "user");
    await approval(w, run, "tc-deny", "denied", "user");
    await approval(w, run, "tc-expired", "expired", "run_interrupted");
    await approval(w, run, "tc-pending", "pending", null);

    const res = await as(w.owner).get(`/v1/threads/${threadId}/markers`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = threadMarkersSchema.parse(res.json); // the documented shape, strictly
    expect(body.runs.map((r) => [r.run_id, r.status, r.user_entry_id])).toEqual([
      [first, "interrupted", "e-1"],
      [second, "budget_stopped", null],
    ]);
    expect(body.runs.every((r) => r.ended_at !== null && r.parent_entry_id === null)).toBe(true);
    expect(body.approvals.map((a) => [a.tool_call_id, a.status, a.cause])).toEqual([
      ["tc-allow", "allowed", "user"],
      ["tc-deny", "denied", "user"],
      ["tc-expired", "expired", "run_interrupted"],
    ]);
    expect(body.approvals.every((a) => a.run_id === first)).toBe(true);
    // Never the checked input or the reasons: the marker needs the outcome only.
    expect(JSON.stringify(res.json)).not.toContain("secret");
  });

  it("is visible like the thread: teammates and other teams get 404, bad ids 400", async () => {
    const w = await f.world(1);
    const mate = w.others[0] as Person;
    const threadId = await f.thread(w.owner);
    const other = await f.world();
    for (const who of [mate, other.owner]) {
      const res = await as(who).get(`/v1/threads/${threadId}/markers`);
      expect(res.status).toBe(404);
      expect(res.json.code).toBe("thread_not_found");
    }
    expect((await as(w.owner).get(`/v1/threads/not-a-uuid/markers`)).status).toBe(400);
  });

  it("shows a project reader the runs but not the owner's approvals", async () => {
    const w = await f.world();
    const reader = await f.member(w.team);
    const project = await as(w.owner).post("/v1/projects", {
      name: "Shared",
      members_mode: "selected",
      member_user_ids: [reader.id],
    });
    expect(project.status, JSON.stringify(project.json)).toBe(201);
    const made = await as(w.owner).post("/v1/threads", { project_id: project.json.id });
    const threadId = made.json.thread_id as string;
    const runId = await f.message(w.owner, threadId, "hello");
    await endRun(w.team, runId, "interrupted", "e-1");
    await approval(w, { runId, threadId, userId: w.owner.id }, "tc-1", "allowed", "user");
    const shared = await as(w.owner).post(`/v1/threads/${threadId}/share`, {
      visibility: "project",
    });
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);

    const res = await as(reader).get(`/v1/threads/${threadId}/markers`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.runs.map((r: { run_id: string }) => r.run_id)).toEqual([runId]);
    expect(res.json.approvals).toEqual([]);
  });
});
