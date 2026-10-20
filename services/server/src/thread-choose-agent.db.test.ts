import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGalleryAgents } from "./gallery/seed.js";
import {
  pinnedApp,
  publishedAgent,
  runConnectors,
  teamModel,
  threadAgent,
} from "./testing/app-launch-fixtures.js";
import { RunFixture, type RunWorld } from "./testing/run-fixture.js";

/**
 * KOBE-458 ac-3: `POST /v1/threads/:id/agent` gives the owner's agentless thread an agent once,
 * checked exactly as thread creation checks `agent_id` (`resolveAgentPin`), so later runs get
 * that agent's connectors. Refused for anything but the owner's own idle, plain conversation.
 */
const f = new RunFixture();
let kobe = "";

beforeAll(async () => {
  await f.setup();
  const [seeded] = await seedGalleryAgents(f.fx.db);
  kobe = seeded?.agentId ?? "";
  expect(kobe).not.toBe("");
});
afterAll(() => f.teardown());

type Person = RunWorld["owner"];

async function world(): Promise<RunWorld & { readonly others: Person[] }> {
  const w = await f.world(1);
  await teamModel(f, w);
  return w;
}

const choose = (who: Person, threadId: string, agentId: string) =>
  who.browser.post(`/v1/threads/${threadId}/agent`, { agent_id: agentId });

const refusal = async (who: Person, threadId: string, agentId: string) => {
  const res = await choose(who, threadId, agentId);
  return [res.status, res.json.code as string];
};

describe("an agentless thread takes an agent (KOBE-458 ac-3)", () => {
  it("gives later runs that agent's connectors, audited", async () => {
    const w = await world();
    const { connector } = await pinnedApp(f, w);
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const first = await f.message(w.owner, threadId, "hello");
    const start = await ws.started(first);
    expect(start.config?.mcp_servers).toBeUndefined();
    ws.reply(start, "hi");
    await expect.poll(() => f.status(w.team, first)).toBe("completed");
    expect(await runConnectors(f, first)).toEqual([]);

    const chosen = await choose(w.owner, threadId, kobe);
    expect(chosen.status, JSON.stringify(chosen.json)).toBe(200);
    expect(chosen.json).toMatchObject({ agent_id: kobe });
    const { rows } = await f.fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'thread.agent_chosen'`,
      [w.team],
    );
    const pinned = await threadAgent(f, threadId);
    expect(rows.map((r) => r.target)).toEqual([
      { threadId, agentId: kobe, scope: "gallery", version: pinned?.agent_version },
    ]);

    const next = await f.message(w.owner, threadId, "and now?");
    const again = await ws.started(next);
    expect(again.config?.mcp_servers?.map((m) => m.connector_id)).toEqual([connector.id]);
    ws.reply(again, "now with tools");
    await expect.poll(() => f.status(w.team, next)).toBe("completed");
    expect(await runConnectors(f, next)).toEqual([connector.id]);
  });
});

describe("choosing an agent is refused (KOBE-458 review LOW-1..3)", () => {
  it("for an agent the member can't start threads with, as at creation", async () => {
    const w = await world();
    const threadId = await f.thread(w.owner);
    const mate = w.others[0];
    if (!mate) throw new Error("no team mate");
    const theirs = await publishedAgent(mate, "personal", "Mine Only");
    const draftOnly = await publishedAgent(w.owner, "team", "Unpublished", false);
    const suspended = await publishedAgent(w.owner, "team", "Paused Bot");
    const paused = await w.owner.browser.put(`/v1/agents/inventory/${suspended}/status`, {
      status: "suspended",
    });
    expect(paused.status, JSON.stringify(paused.json)).toBe(200);
    const archived = await publishedAgent(w.owner, "team", "Old Bot");
    expect((await w.owner.browser.request("DELETE", `/v1/agents/${archived}`)).status).toBe(200);
    const elsewhere = await world();
    const otherTeams = await publishedAgent(elsewhere.owner, "team", "Their Team Bot");

    expect(await refusal(w.owner, threadId, theirs)).toEqual([404, "agent_not_found"]);
    expect(await refusal(w.owner, threadId, otherTeams)).toEqual([404, "agent_not_found"]);
    expect(await refusal(w.owner, threadId, randomUUID())).toEqual([404, "agent_not_found"]);
    for (const id of [draftOnly, suspended, archived]) {
      expect(await refusal(w.owner, threadId, id)).toEqual([409, "agent_unavailable"]);
    }
    expect(await threadAgent(f, threadId)).toMatchObject({ agent_id: null });
  });

  it("for anyone but the owner: a stranger gets not found, a reader read-only", async () => {
    const w = await world();
    const mate = w.others[0];
    if (!mate) throw new Error("no team mate");
    const threadId = await f.thread(w.owner);
    expect(await refusal(mate, threadId, kobe)).toEqual([404, "thread_not_found"]);
    const shared = await w.owner.browser.post(`/v1/threads/${threadId}/share`, {
      visibility: "team",
    });
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);
    expect(await refusal(mate, threadId, kobe)).toEqual([403, "read_only"]);
    expect(await threadAgent(f, threadId)).toMatchObject({ agent_id: null });
  });

  it("once the thread has an agent, and for a malformed body", async () => {
    const w = await world();
    const threadId = await f.thread(w.owner);
    expect((await choose(w.owner, threadId, kobe)).status).toBe(200);
    expect(await refusal(w.owner, threadId, kobe)).toEqual([409, "agent_already_chosen"]);
    const bad = await w.owner.browser.post(`/v1/threads/${threadId}/agent`, { agent_id: "x" });
    expect(bad.status).toBe(400);
  });

  it("while a run is queued or active (its message was written for a plain chat)", async () => {
    const w = await world();
    const threadId = await f.thread(w.owner);
    // No sandbox: the run waits as queued (or starts waking one); either way it is pending.
    const runId = await f.message(w.owner, threadId, "hello");
    expect(["queued", "running", "waking"]).toContain(await f.status(w.team, runId));
    expect(await refusal(w.owner, threadId, kobe)).toEqual([409, "thread_busy"]);
  });

  it("for a thread in Trash, an archived thread, and builder, Workbench, eval or scheduled threads", async () => {
    const w = await world();
    const admin = f.fx.admin;
    const thread = async (set: string, params: unknown[] = []) => {
      const id = await f.thread(w.owner);
      await admin.query(`UPDATE threads SET ${set} WHERE id = $1`, [id, ...params]);
      return id;
    };
    const trashed = await thread("deleted_at = now()");
    const archived = await thread("archived_at = now()");
    const builder = await thread("is_test = true");
    const workbench = await thread("skill_test = true");
    // An eval thread is created as one and always pinned: its flag never changes, so the test
    // sets it with triggers off, for the refusal that doesn't rely on the pin.
    const evalThread = await f.thread(w.owner);
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query(`UPDATE threads SET skill_eval = true WHERE id = $1`, [evalThread]);
    await admin.query("COMMIT");
    const schedule = randomUUID();
    await admin.query(
      `INSERT INTO schedules (team_id, id, user_id, agent_id, prompt, recurrence, tz, active, next_due_at)
       VALUES ($1, $2, $3, $4, 'p', '{"kind":"daily","at":"09:00"}', 'UTC', true, now())`,
      [w.team, schedule, w.owner.id, randomUUID()],
    );
    const scheduled = await thread("schedule_id = $2", [schedule]);

    expect(await refusal(w.owner, trashed, kobe)).toEqual([409, "thread_in_trash"]);
    expect(await refusal(w.owner, archived, kobe)).toEqual([409, "thread_archived"]);
    for (const id of [builder, workbench]) {
      expect(await refusal(w.owner, id, kobe)).toEqual([409, "test_thread"]);
    }
    // An eval thread is refused before the route runs (the thread routes keep members out).
    expect((await refusal(w.owner, evalThread, kobe))[1]).toBe("skill_eval_thread");
    expect(await refusal(w.owner, scheduled, kobe)).toEqual([409, "scheduled_thread"]);
    for (const id of [trashed, archived, builder, workbench, evalThread, scheduled]) {
      expect(await threadAgent(f, id)).toMatchObject({ agent_id: null });
    }
  });
});
