import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { threadPageSchema, threadSummarySchema } from "./threads/schemas.js";
import { RunFixture } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-301: thread summaries say `pending_approval: true` while the thread holds an approval only
 * the caller can decide (pending, not expired, on their own run), so the rail can show an amber
 * dot for a thread that is not open. Readers of a shared thread and other teams never see it.
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

const as = (p: Person) => f.on(0, p);

async function approval(
  team: string,
  run: { runId: string; threadId: string; userId: string },
  toolCallId: string,
  options: { status?: "pending" | "denied"; expiresIn?: string } = {},
) {
  const status = options.status ?? "pending";
  await f.fx.admin.query(
    `INSERT INTO approvals (team_id, id, run_id, thread_id, user_id, connection_id, tool_call_id,
                            tool, input_canonical, risk, reasons, status, cause, decided_at,
                            decided_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, gen_random_uuid(), $6, 'bash', '{}', 'write', '[]',
             $7::approval_status, CASE WHEN $7::text = 'pending' THEN NULL ELSE 'user' END,
             CASE WHEN $7::text = 'pending' THEN NULL ELSE now() END,
             CASE WHEN $7::text = 'pending' THEN NULL ELSE $5::uuid END,
             now() + $8::interval)`,
    [
      team,
      randomUUID(),
      run.runId,
      run.threadId,
      run.userId,
      toolCallId,
      status,
      options.expiresIn ?? "1 hour",
    ],
  );
}

/** `pending_approval` of `threadId` in a list answer (`undefined` = absent). */
async function flagIn(p: Person, path: string, threadId: string): Promise<unknown> {
  const res = await as(p).get(path);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const page = threadPageSchema.parse(res.json); // the documented shape
  const found = page.threads.find((t) => t.thread_id === threadId);
  expect(found, `${threadId} in ${path}`).toBeDefined();
  return found?.pending_approval;
}

describe("pending_approval on thread summaries (KOBE-301)", () => {
  it("is true only while the caller's own approval is pending and unexpired", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const runId = await f.message(w.owner, threadId, "hello");
    const run = { runId, threadId, userId: w.owner.id };
    expect(await flagIn(w.owner, "/v1/threads", threadId)).toBeUndefined();

    await approval(w.team, run, "tc-expired", { expiresIn: "-1 minute" });
    await approval(w.team, run, "tc-denied", { status: "denied" });
    expect(await flagIn(w.owner, "/v1/threads", threadId)).toBeUndefined();

    await approval(w.team, run, "tc-pending");
    expect(await flagIn(w.owner, "/v1/threads", threadId)).toBe(true);
    // The thread read (`GET /v1/threads/{id}`, the open thread's summary) agrees with the list.
    const one = await as(w.owner).get(`/v1/threads/${threadId}?limit=1`);
    expect(one.status, JSON.stringify(one.json)).toBe(200);
    expect(threadSummarySchema.parse(one.json).pending_approval).toBe(true);

    await f.fx.admin.query(
      `UPDATE approvals SET status = 'allowed', cause = 'user', decided_at = now(), decided_by = $3,
              token_kid = 'k1', token_expires_at = now() + interval '1 hour',
              input_hmac = repeat('a', 43)
        WHERE team_id = $1 AND tool_call_id = $2`,
      [w.team, "tc-pending", w.owner.id],
    );
    expect(await flagIn(w.owner, "/v1/threads", threadId)).toBeUndefined();
  });

  it("never shows to a reader of a shared thread: only the run's user may decide", async () => {
    const w = await f.world(1);
    const mate = w.others[0] as Person;
    const threadId = await f.thread(w.owner);
    const shared = await as(w.owner).post(`/v1/threads/${threadId}/share`, { visibility: "team" });
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);
    const runId = await f.message(w.owner, threadId, "hello");
    await approval(w.team, { runId, threadId, userId: w.owner.id }, "tc-1");

    expect(await flagIn(w.owner, "/v1/threads", threadId)).toBe(true);
    expect(await flagIn(mate, "/v1/threads/shared", threadId)).toBeUndefined();
  });

  it("is per team: another team's pending approval never marks a thread here", async () => {
    const a = await f.world();
    const b = await f.world();
    const threadA = await f.thread(a.owner);
    const threadB = await f.thread(b.owner);
    const runB = await f.message(b.owner, threadB, "hello");
    await approval(b.team, { runId: runB, threadId: threadB, userId: b.owner.id }, "tc-b");

    expect(await flagIn(a.owner, "/v1/threads", threadA)).toBeUndefined();
    expect(await flagIn(b.owner, "/v1/threads", threadB)).toBe(true);
  });
});
