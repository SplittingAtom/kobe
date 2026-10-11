import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { FAILURE_MESSAGES } from "./runs/failure-codes.js";

/**
 * KOBE-258: a run's conversation entries at run end. A turn cut off at the model's output limit is
 * kept and fails the run visibly; a Pi that no longer knows the mirrored cursor while Postgres
 * holds no conversation yet (Pi 1.0.0 setup entries mirrored before they were durable) is adopted
 * instead of being overwritten by a restore; a sync that still fails never ends the run completed.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
let listener: Awaited<ReturnType<typeof sandboxListener>>;
const sandboxes: FakeSandbox[] = [];

beforeAll(async () => {
  await fx.setup([{}], () => ({
    sandboxWire: { sweep: false, tuning: { batchWindowMs: 10 } },
  }));
  listener = await sandboxListener(fx.replica(0).deps, auth);
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  await listener.close();
  await fx.teardown();
});

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly runId: string;
  readonly threadId: string;
  readonly sb: FakeSandbox;
}

type SessionEntry = FakeSandbox["session"][number];
const t = new Date().toISOString();
const setup = (id: string): SessionEntry => ({
  type: "thinking_level_change",
  id,
  parentId: null,
  timestamp: t,
  thinkingLevel: "off",
});
const msg = (id: string, parentId: string | null, role: string, extra = {}): SessionEntry => ({
  type: "message",
  id,
  parentId,
  timestamp: t,
  message: { role, content: [], ...extra },
});

async function world(session: SessionEntry[]): Promise<World> {
  const owner = await fx.person(`e${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`e-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  const threadId = must(rows[0], "run").thread_id;
  const sandboxId = randomUUID();
  const sb = await FakeSandbox.connect(
    listener.url,
    auth.issue({ sandboxId, teamId: team, userId: owner.id }),
  );
  if (!isFake(sb)) throw new Error("refused");
  sandboxes.push(sb);
  sb.session = session;
  sb.hello(sandboxId);
  await sb.ready();
  return { team, owner, runId, threadId, sb };
}

async function start(w: World, runId: string): Promise<void> {
  const result = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: w.team, userId: w.owner.id },
      { runId, threadId: w.threadId, message: "make a dashboard" },
    );
  expect(result).toEqual({ ok: true });
}

/** Pi's events for one turn whose assistant message stops with `stopReason`, then settle. */
function playTurn(w: World, runId: string, stopReason: string): number {
  const frames = [
    { type: "agent_start" },
    { type: "message_start", message: { role: "assistant" } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "<html>" },
    },
    { type: "message_end", message: { role: "assistant", stopReason } },
    { type: "turn_end", message: { role: "assistant" } },
    { type: "agent_settled" },
  ];
  frames.forEach((e, i) => w.sb.event(runId, w.threadId, i + 1, e));
  return frames.length;
}

async function entryIds(w: World): Promise<string[]> {
  const { rows } = await fx.admin.query<{ entry_id: string }>(
    `SELECT entry_id FROM thread_entries WHERE team_id = $1 AND thread_id = $2 ORDER BY seq`,
    [w.team, w.threadId],
  );
  return rows.map((r) => r.entry_id);
}

async function lastEvent(w: World, runId: string) {
  const { rows } = await fx.admin.query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM run_events WHERE team_id = $1 AND run_id = $2
      ORDER BY seq DESC LIMIT 1`,
    [w.team, runId],
  );
  return must(rows[0], "event");
}

async function status(w: World, runId: string): Promise<string> {
  const { rows } = await fx.admin.query<{ status: string }>(
    `SELECT status FROM runs WHERE team_id = $1 AND id = $2`,
    [w.team, runId],
  );
  return must(rows[0], "run").status;
}

async function settledRun(w: World, runId: string, stopReason: string): Promise<void> {
  const n = playTurn(w, runId, stopReason);
  await w.sb.until(() => w.sb.acked(runId) >= n, 15_000);
}

describe("run end entries (KOBE-258)", () => {
  it("keeps a turn cut off at the output limit and fails the run with that reason", async () => {
    const w = await world([]);
    await start(w, w.runId);
    w.sb.session = [
      msg("u1", null, "user"),
      msg("a1", "u1", "assistant", { stopReason: "length" }),
    ];
    await settledRun(w, w.runId, "length");
    expect(await entryIds(w)).toEqual(["u1", "a1"]);
    expect(await status(w, w.runId)).toBe("failed");
    expect(await lastEvent(w, w.runId)).toEqual({
      type: "run.failed",
      payload: {
        error: { code: "model_output_limit", message: FAILURE_MESSAGES.model_output_limit },
      },
    });
  });

  it("adopts Pi's session when it lost the cursor and Postgres has no conversation yet", async () => {
    // The incident: a bare Pi's in-memory setup entry was mirrored; the run's Pi made new ones.
    const w = await world([setup("x0")]);
    await start(w, w.runId);
    expect(await entryIds(w)).toEqual(["x0"]);
    w.sb.session = [setup("y0"), msg("u1", "y0", "user"), msg("a1", "u1", "assistant")];
    await settledRun(w, w.runId, "stop");
    expect(await entryIds(w)).toEqual(["x0", "y0", "u1", "a1"]);
    expect(await status(w, w.runId)).toBe("completed");
    expect(await lastEvent(w, w.runId)).toMatchObject({
      type: "run.completed",
      payload: { leaf_entry_id: "a1" },
    });

    // The next run continues Pi's session: no restore from Postgres over it.
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
      [w.team, w.threadId],
    );
    const next = must(rows[0], "run").id;
    await start(w, next);
    await w.sb.until(() => w.sb.received.find((f) => f.type === "run.start" && f.run_id === next));
    expect(w.sb.restored).toEqual([]);
  });

  it("never completes a run whose entries could not be saved", async () => {
    const w = await world([msg("u0", null, "user"), msg("a0", "u0", "assistant")]);
    await start(w, w.runId);
    expect(await entryIds(w)).toEqual(["u0", "a0"]);
    // Pi lost the conversation Postgres has: no adoption (the next run restores instead).
    w.sb.session = [setup("y0"), msg("u1", "y0", "user"), msg("a1", "u1", "assistant")];
    await settledRun(w, w.runId, "stop");
    expect(await entryIds(w)).toEqual(["u0", "a0"]);
    expect(await status(w, w.runId)).toBe("failed");
    expect(await lastEvent(w, w.runId)).toEqual({
      type: "run.failed",
      payload: {
        error: { code: "entries_not_saved", message: FAILURE_MESSAGES.entries_not_saved },
      },
    });
  });
});
