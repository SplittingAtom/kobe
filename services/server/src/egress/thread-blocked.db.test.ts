import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Person } from "../testing/event-stream-fixture.js";
import { RunFixture, type RunWorld } from "../testing/run-fixture.js";

/**
 * `GET /v1/threads/{id}/egress-blocked` (KOBE-605): the thread's stored `egress.blocked` events
 * per run, so each answer keeps its blocked cards after the run ended and after a reload. One row
 * per (run, domain), the first; other threads' runs and other event types are left out; readers
 * of a shared thread see them, others get 404.
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

const as = (p: Person) => f.on(0, p);

async function endedRun(w: RunWorld, threadId: string, userEntryId: string | null) {
  const runId = await f.message(w.owner, threadId, "go");
  await f.fx.admin.query(
    `UPDATE runs SET status = 'completed', queue_pos = NULL, started_at = coalesce(started_at, now()),
            ended_at = now(), user_entry_id = $3
      WHERE team_id = $1 AND id = $2`,
    [w.team, runId, userEntryId],
  );
  return runId;
}

async function event(w: RunWorld, runId: string, type: string, payload: Record<string, unknown>) {
  await f.fx.admin.query(
    `INSERT INTO run_events (team_id, run_id, type, payload) VALUES ($1, $2, $3, $4)`,
    [w.team, runId, type, payload],
  );
}

const blocked = (domain: string, reason = "not_in_ceiling") => ({
  domain,
  request_access: true,
  reason,
});

describe("thread egress-blocked read (KOBE-605)", () => {
  it("lists each run's first block per domain with its prompt entry, for owner and reader", async () => {
    const w = await f.world();
    const reader = await f.member(w.team);
    const threadId = await f.thread(w.owner);
    const shared = await as(w.owner).post(`/v1/threads/${threadId}/share`, { visibility: "team" });
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);

    const empty = await as(w.owner).get(`/v1/threads/${threadId}/egress-blocked`);
    expect([empty.status, empty.json]).toEqual([200, { blocked: [] }]);

    const first = await endedRun(w, threadId, "u1");
    await event(w, first, "egress.blocked", blocked("example.org"));
    await event(w, first, "egress.blocked", blocked("example.org", "forbidden_address"));
    await event(w, first, "steer.applied", { content: "not a block" });
    const second = await endedRun(w, threadId, null);
    await event(w, second, "egress.blocked", blocked("example.org"));
    await event(w, second, "egress.blocked", blocked("pypi.org", "not_enabled"));
    // Another thread's run is not this thread's.
    const other = await endedRun(w, await f.thread(w.owner), "x1");
    await event(w, other, "egress.blocked", blocked("elsewhere.org"));

    const read = await as(w.owner).get(`/v1/threads/${threadId}/egress-blocked`);
    expect(read.status).toBe(200);
    const rows = (read.json as { blocked: Record<string, unknown>[] }).blocked;
    expect(
      rows.map((r) => [r.run_id, r.user_entry_id, (r.payload as { domain: string }).domain]),
    ).toEqual([
      [first, "u1", "example.org"],
      [second, null, "example.org"],
      [second, null, "pypi.org"],
    ]);
    // The first block of the domain in the run, not the later forbidden_address one.
    expect(rows[0]).toMatchObject({ payload: blocked("example.org") });
    expect(typeof rows[0]?.ts).toBe("string");

    expect((await as(reader).get(`/v1/threads/${threadId}/egress-blocked`)).json).toEqual(
      read.json,
    );
    const outsider = await f.member((await f.world()).team);
    const hidden = await as(outsider).get(`/v1/threads/${threadId}/egress-blocked`);
    expect([hidden.status, hidden.json.code]).toEqual([404, "thread_not_found"]);
    const unshared = await f.thread(w.owner);
    const nosy = await as(reader).get(`/v1/threads/${unshared}/egress-blocked`);
    expect([nosy.status, nosy.json.code]).toEqual([404, "thread_not_found"]);
  });
});
