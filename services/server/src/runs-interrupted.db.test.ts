import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunFixture, type FakeWorkspace, type RunWorld } from "./testing/run-fixture.js";

/**
 * Interrupted runs and manual Retry (KOBE-26, spec D14, Gate 1) end to end against a real
 * Postgres, the real sandbox wire over WebSockets and two replicas: the paths a dying sandbox
 * takes (pod killed and recreated with its volume, volume lost), history read while interrupted,
 * and where Retry branches.
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});

afterAll(async () => {
  await f.teardown();
});

const entryId = () => randomBytes(4).toString("hex");

/** Pi 1.0 writes a settings entry (thinking level, model) at the root before the first prompt. */
function rootSettingsEntry() {
  return {
    type: "thinking_level_change",
    id: entryId(),
    parentId: null,
    timestamp: new Date().toISOString(),
    thinkingLevel: "off",
  };
}

async function entryIds(team: string, threadId: string): Promise<string[]> {
  const { rows } = await f.fx.admin.query<{ entry_id: string }>(
    `SELECT entry_id FROM thread_entries WHERE team_id = $1 AND thread_id = $2 ORDER BY seq`,
    [team, threadId],
  );
  return rows.map((r) => r.entry_id);
}

async function commandCount(team: string): Promise<number> {
  const { rows } = await f.fx.admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM sandbox_commands WHERE team_id = $1`,
    [team],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Starts a run, mirrors partial progress (turn_end, no settle) and returns its ids. */
async function runHalfway(ws: FakeWorkspace, w: RunWorld, threadId: string, prompt: string) {
  const runId = await f.message(w.owner, threadId, prompt);
  const start = await ws.started(runId);
  const ids = ws.reply(start, "half way", false);
  await ws.acked(runId);
  await expect.poll(() => entryIds(w.team, threadId)).toContain(ids.assistant);
  return { runId, start, ids };
}

/** Kills the sandbox's connection and lets the lost-sandbox sweep interrupt the run. */
async function killAndSweep(ws: FakeWorkspace, team: string, runId: string): Promise<void> {
  ws.kill();
  await ws.sb.waitClosed();
  await expect
    .poll(async () => {
      await f.fx.replica(1).deps.sandboxWire.sweep();
      return f.status(team, runId);
    })
    .toBe("interrupted");
}

describe("Retry branches beside the interrupted prompt (D14)", () => {
  it("retries a thread's first run as a sibling of its prompt, not after the partial answer", async () => {
    const w = await f.world();
    let ws = await f.connect(w, 0);
    const threadId = await f.thread(w.owner);
    const root = rootSettingsEntry();
    ws.sessions.set(threadId, [root]);
    const { runId, start, ids } = await runHalfway(ws, w, threadId, "first and risky");
    // An empty thread has no branch point: Pi continues from its leaf (the settings entry).
    expect(start.parent_entry_id).toBeUndefined();
    await killAndSweep(ws, w.team, runId);
    const before = await entryIds(w.team, threadId);
    expect(before).toEqual([root.id, ids.user, ids.assistant]);

    ws = await f.connect(w, 1); // a new pod without the volume: the session is restored
    const retry = await f.on(1, w.owner).post(`/v1/runs/${runId}/retry`);
    expect(retry.status, JSON.stringify(retry.json)).toBe(201);
    const retryId = retry.json.run_id as string;
    const retryStart = await ws.started(retryId);
    // Branch point = the parent of the interrupted prompt, so the retry is its sibling.
    expect(retryStart).toMatchObject({ message: "first and risky", parent_entry_id: root.id });
    expect((await f.run(w.team, retryId)).parent_entry_id).toBe(root.id);
    const retried = ws.reply(retryStart, "done");
    await f.until(w.team, retryId, "completed");
    const { rows } = await f.fx.admin.query<{ entry_id: string }>(
      `SELECT entry_id FROM thread_entries WHERE team_id = $1 AND thread_id = $2 AND parent_id = $3`,
      [w.team, threadId, root.id],
    );
    expect(rows.map((r) => r.entry_id).sort()).toEqual([ids.user, retried.user].sort());
    expect(await entryIds(w.team, threadId)).toEqual(expect.arrayContaining(before));
  });
});

describe("a sandbox pod killed and recreated with its volume (D14, Gate 1)", () => {
  it("interrupts at once on the new pod's hello, keeps what Pi wrote after the last sync, and retries", async () => {
    const w = await f.world();
    const old = await f.connect(w, 0);
    const threadId = await f.thread(w.owner);
    const warm = await f.message(w.owner, threadId, "warm up");
    const base = old.reply(await old.started(warm), "ready").assistant;
    await f.until(w.team, warm, "completed");
    const { runId, ids } = await runHalfway(old, w, threadId, "edit the files");
    // Pi appended a tool result after the last mirror, then the pod died.
    const session = old.sessions.get(threadId) ?? [];
    const tail = {
      type: "message",
      id: entryId(),
      parentId: ids.assistant,
      timestamp: new Date().toISOString(),
      message: { role: "toolResult", toolCallId: "c1", toolName: "write", content: [] },
    };
    old.kill();
    await old.sb.waitClosed();

    // The recreated pod mounts the same volume: Pi's session file is still there, no run is live.
    const ws = await f.connect(w, 1);
    ws.sessions.set(threadId, [...session, tail]);
    await f.until(w.team, runId, "interrupted"); // its hello does not list the run: no grace
    expect(await f.threadStatus(w.team, threadId)).toBe("interrupted");
    expect((await f.events(w.team, runId)).at(-1)).toMatchObject({
      type: "run.interrupted",
      payload: { reason: "sandbox_lost", retryable: true },
    });
    const { rows: audit } = await f.fx.admin.query<{ target: { runId?: string; cause?: string } }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'run.interrupted'`,
      [w.team],
    );
    expect(audit.map((a) => a.target)).toContainEqual(
      expect.objectContaining({ runId, cause: "not_resumed" }),
    );

    const retry = await f.on(0, w.owner).post(`/v1/runs/${runId}/retry`);
    expect(retry.status, JSON.stringify(retry.json)).toBe(201);
    const retryStart = await ws.started(retry.json.run_id as string);
    expect(retryStart.parent_entry_id).toBe(base);
    // Before the retry started, the entries Pi kept on the volume were mirrored (no restore).
    expect(await entryIds(w.team, threadId)).toContain(tail.id);
    expect(ws.sb.frames("session.restore")).toHaveLength(0);
    ws.reply(retryStart, "done");
    await f.until(w.team, retry.json.run_id as string, "completed");
    expect(await f.threadStatus(w.team, threadId)).toBe("idle");
  });
});

describe("history while interrupted (D14: reading never wakes a sandbox)", () => {
  it("shows the thread interrupted with its entries, the run to retry and the closed stream", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0);
    const threadId = await f.thread(w.owner);
    const { runId, ids } = await runHalfway(ws, w, threadId, "long job");
    await killAndSweep(ws, w.team, runId);
    const commands = await commandCount(w.team);

    const browser = f.on(1, w.owner);
    const detail = await browser.get(`/v1/threads/${threadId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.status).toBe("interrupted");
    expect((detail.json.entries as { entry_id: string }[]).map((e) => e.entry_id)).toEqual([
      ids.user,
      ids.assistant,
    ]);
    const list = await browser.get("/v1/threads");
    expect(
      (list.json.threads as { thread_id: string; status: string }[]).find(
        (t) => t.thread_id === threadId,
      )?.status,
    ).toBe("interrupted");
    const runs = await browser.get(`/v1/threads/${threadId}/runs`);
    expect(runs.json.interrupted_run).toMatchObject({ run_id: runId, status: "interrupted" });
    const stream = await browser.get(`/v1/runs/${runId}/events`);
    expect(stream.status).toBe(200);
    expect(stream.text).toMatch(/event: run\.interrupted\n/);
    expect(stream.text).toContain('"retryable":true');
    // None of these reads enqueued anything for the sandbox (no wake).
    expect(await commandCount(w.team)).toBe(commands);
  });
});
