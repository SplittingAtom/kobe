import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pendingMessagesSchema } from "./routes/thread-pending.js";
import { must } from "./testing/event-stream-fixture.js";
import { RunFixture } from "./testing/run-fixture.js";

/**
 * `GET /v1/threads/{id}/pending-messages` (KOBE-32): the text of queued messages and of the active
 * run's prompt, against a real Postgres and the real orchestrator; authorization like the thread's
 * runs (owner; other users and teams get the same 404).
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});

afterAll(async () => {
  await f.teardown();
});

describe("GET /v1/threads/{id}/pending-messages", () => {
  it("lists the active run's prompt, then queued messages in start order, as last edited", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const b = f.on(1, w.owner);
    expect((await b.get(`/v1/threads/${threadId}/pending-messages`)).json).toEqual({
      messages: [],
    });

    const first = await f.message(w.owner, threadId, "first"); // no sandbox: running, start pending
    const second = await f.message(w.owner, threadId, "second");
    const third = await f.message(w.owner, threadId, "third");
    expect((await b.patch(`/v1/runs/${second}`, { content: "second, edited" })).status).toBe(200);

    const res = await b.get(`/v1/threads/${threadId}/pending-messages`);
    expect(res.status).toBe(200);
    const body = pendingMessagesSchema.parse(res.json); // the documented shape, strictly
    expect(body.messages).toEqual([
      { run_id: first, status: "running", content: "first", parent_entry_id: null },
      {
        run_id: second,
        status: "queued",
        queue_pos: 1,
        content: "second, edited",
        parent_entry_id: null,
      },
      { run_id: third, status: "queued", queue_pos: 2, content: "third", parent_entry_id: null },
    ]);

    // A deleted queued message and a stopped run are no longer pending.
    expect((await b.post(`/v1/runs/${second}/cancel`)).status).toBe(200);
    expect((await b.post(`/v1/runs/${first}/cancel`)).status).toBe(200);
    await expect
      .poll(async () => {
        const after = await b.get(`/v1/threads/${threadId}/pending-messages`);
        return (after.json.messages as { run_id: string; status: string }[]).map((m) => [
          m.run_id,
          m.status,
        ]);
      })
      .toEqual([[third, "running"]]);
  });

  it("keeps the branch point of a message sent with parent_entry_id", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "hello");
    const ids = ws.reply(await ws.started(run), "hi!");
    await f.until(w.team, run, "completed");
    const edit = await f.send(w.owner, threadId, "hello, edited", 0, { parent_entry_id: ids.user });
    expect(edit.status).toBe(201);
    const res = await f.on(0, w.owner).get(`/v1/threads/${threadId}/pending-messages`);
    expect(res.json.messages).toEqual([
      {
        run_id: edit.json.run_id,
        status: "running",
        content: "hello, edited",
        parent_entry_id: ids.user,
      },
    ]);
  });

  it("is the owner's: teammates, other teams and removed members can't read it", async () => {
    const w = await f.world(1);
    const mate = must(w.others[0], "teammate");
    const threadId = await f.thread(w.owner);
    await f.message(w.owner, threadId, "private prompt");
    const other = await f.world();
    for (const [who, label] of [
      [mate, "teammate"],
      [other.owner, "other team"],
    ] as const) {
      const res = await f.on(0, who).get(`/v1/threads/${threadId}/pending-messages`);
      expect(res.status, label).toBe(404);
      expect(res.json.code, label).toBe("thread_not_found");
      expect(JSON.stringify(res.json), label).not.toContain("private prompt");
    }
    const bad = await f.on(0, w.owner).get(`/v1/threads/not-a-uuid/pending-messages`);
    expect(bad.status).toBe(400);

    const anonymous = f.on(0, w.owner);
    anonymous.cookies.clear();
    expect((await anonymous.get(`/v1/threads/${threadId}/pending-messages`)).status).toBe(401);

    await f.fx.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      w.team,
      w.owner.id,
    ]);
    expect((await f.on(0, w.owner).get(`/v1/threads/${threadId}/pending-messages`)).status).toBe(
      403,
    );
  });
});
