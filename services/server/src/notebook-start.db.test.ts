import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAPABILITY_NOTEBOOK_START,
  CAPABILITY_NOTEBOOKS,
  notebookStartResponseSchema,
  type PolicyEngine,
  type SandboxToServerFrame,
  type ServerToSandboxFrame,
} from "@kobe/protocol";
import { EventStreamFixture, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { SandboxWakeError, type SandboxRouter } from "./sandbox-wire/types.js";

/**
 * KOBE-477 (docs/specs/notebooks.md NB19): `POST /v1/threads/{id}/notebook/start` wakes the
 * owner's sandbox (202 `waking`) and starts the thread's kernel without running code
 * (`notebook.restart` with `op: "start"`, only to agents with `notebook_start`). Owner only.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;

const allowAll: PolicyEngine = {
  decide: () =>
    Promise.resolve({
      effect: "allow" as const,
      risk: "destructive" as const,
      reasons: [{ code: "risk_read" as const, stage: "risk_class" as const, message: "ok" }],
    }),
};

beforeAll(async () => {
  await fx.setup([{}], () => ({
    sandboxWire: {
      engine: allowAll,
      sweep: false,
      tuning: { batchWindowMs: 20, resultPollMs: 100, lostGraceMs: 0, helloTimeoutMs: 1_000 },
    },
    runs: { sweep: false },
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
  readonly reader: Person;
  readonly threadId: string;
  readonly sandboxId: string;
  readonly token: string;
}

async function world(evalThread = false): Promise<World> {
  const owner = await fx.person(`s${randomBytes(2).toString("hex")}`);
  const reader = await fx.person(`r${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`nbs-${randomBytes(3).toString("hex")}`, owner, [reader]);
  const threadId = randomUUID();
  await fx.admin.query(
    `INSERT INTO threads (id, team_id, owner_user_id, title, skill_eval)
     VALUES ($1, $2, $3, 'nb', $4)`,
    [threadId, team, owner.id, evalThread],
  );
  const sandboxId = randomUUID();
  return {
    team,
    owner,
    reader,
    threadId,
    sandboxId,
    token: auth.issue({ sandboxId, teamId: team, userId: owner.id }),
  };
}

type RestartFrame = Extract<ServerToSandboxFrame, { type: "notebook.restart" }>;

/** A sandbox answering every `notebook.restart` with `answer(frame)` as its result data. */
async function connected(
  w: World,
  answer: (frame: RestartFrame) => unknown = () => ({ status: "idle" }),
  capabilities: readonly string[] = [CAPABILITY_NOTEBOOKS, CAPABILITY_NOTEBOOK_START],
) {
  const sb = await FakeSandbox.connect(listener.url, w.token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.respond = (frame): SandboxToServerFrame | undefined => {
    if (frame.type !== "notebook.restart") return undefined;
    return {
      v: 1,
      type: "command.result",
      command_id: frame.command_id,
      ok: true,
      data: answer(frame),
    } as SandboxToServerFrame;
  };
  sb.hello(w.sandboxId, [], "1.0.0", capabilities);
  await sb.ready();
  return sb;
}

const start = (w: World, who: Person = w.owner, threadId = w.threadId) =>
  who.browser.post(`/v1/threads/${threadId}/notebook/start`, {});

const router = () => fx.replica(0).deps.sandboxWire.router as SandboxRouter & { wake: unknown };

/** Runs `fn` with the router's wake replaced; counts the wakes. */
async function withWake<T>(
  wake: () => Promise<void>,
  fn: (wakes: () => number) => Promise<T>,
): Promise<T> {
  let count = 0;
  router().wake = () => {
    count += 1;
    return wake();
  };
  try {
    return await fn(() => count);
  } finally {
    delete (router() as { wake?: unknown }).wake;
  }
}

describe("POST /v1/threads/{id}/notebook/start (KOBE-477)", () => {
  it("starts the kernel in a connected sandbox, running nothing", async () => {
    const w = await world();
    const sb = await connected(w);
    const res = await start(w);
    expect([res.status, res.json]).toEqual([200, { status: "idle" }]);
    expect(notebookStartResponseSchema.safeParse(res.json).success).toBe(true);
    expect(sb.frames("notebook.restart")).toMatchObject([{ thread_id: w.threadId, op: "start" }]);
    expect(sb.frames("notebook.execute")).toEqual([]);
    // No run: starting a kernel is not a turn, and the thread stays idle.
    const runs = await fx.admin.query(`SELECT 1 FROM runs WHERE team_id = $1`, [w.team]);
    expect(runs.rowCount).toBe(0);
    // A plain restart still carries no op.
    await w.owner.browser.post(`/v1/threads/${w.threadId}/notebook/restart`, {});
    expect(sb.frames("notebook.restart")[1]).not.toHaveProperty("op");
  });

  it("says busy while the kernel runs a cell", async () => {
    const w = await world();
    await connected(w, () => ({ status: "busy" }));
    const res = await start(w);
    expect([res.status, res.json]).toEqual([200, { status: "busy" }]);
  });

  it("wakes a sandbox that is not connected and answers 202 waking", async () => {
    const w = await world();
    await withWake(
      () => new Promise<void>(() => undefined),
      async (wakes) => {
        const res = await start(w);
        expect(res.status, JSON.stringify(res.json)).toBe(202);
        expect(res.json).toEqual({ status: "waking", retry_after_ms: 2000 });
        expect(wakes()).toBe(1);
      },
    );
  });

  it("reports a refused wake, at once or on the next start", async () => {
    const w = await world();
    const refused = () => new SandboxWakeError("isolation_runtime_missing", "no runtime class");
    await withWake(
      () => Promise.reject(refused()),
      async () => {
        const res = await start(w);
        expect(res.status).toBe(409);
        expect(res.json).toMatchObject({ code: "sandbox_refused" });
      },
    );
    let rejectLater: (err: Error) => void = () => undefined;
    const late = new Promise<void>((_resolve, reject) => {
      rejectLater = reject;
    });
    await withWake(
      () => late,
      async () => {
        expect((await start(w)).status).toBe(202);
        rejectLater(refused());
        await late.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 10));
        const next = await start(w);
        expect([next.status, (next.json as { code?: string }).code]).toEqual([
          409,
          "sandbox_refused",
        ]);
      },
    );
    // A transient failure keeps the web waiting.
    await withWake(
      () => Promise.reject(new Error("api server hiccup")),
      async () => {
        expect((await start(w)).status).toBe(202);
      },
    );
  });

  it("is the owner's only: a shared reader is read_only, anyone else 404, nothing woken", async () => {
    const w = await world();
    const sb = await connected(w);
    await fx.activate(w.reader, w.team);
    expect((await start(w, w.reader)).status).toBe(404);
    await fx.admin.query(`UPDATE threads SET shared_to_team = true WHERE id = $1`, [w.threadId]);
    const shared = await start(w, w.reader);
    expect([shared.status, (shared.json as { code?: string }).code]).toEqual([403, "read_only"]);
    expect((await start(w, w.owner, randomUUID())).status).toBe(404);
    expect(sb.frames("notebook.restart")).toEqual([]);
  });

  it("refuses an eval thread, an agent without notebook_start and an invalid answer", async () => {
    const evalWorld = await world(true);
    await withWake(
      () => Promise.resolve(),
      async (wakes) => {
        expect((await start(evalWorld)).status).toBe(409);
        expect(wakes()).toBe(0);
      },
    );

    const old = await world();
    const oldSb = await connected(old, undefined, [CAPABILITY_NOTEBOOKS]);
    const refused = await start(old);
    expect([refused.status, (refused.json as { code?: string }).code]).toEqual([
      409,
      "notebooks_unsupported",
    ]);
    // Never sent: an older agent cannot read the op.
    expect(oldSb.frames("notebook.restart")).toEqual([]);

    const odd = await world();
    await connected(odd, () => ({ status: "restarted" }));
    const invalid = await start(odd);
    expect([invalid.status, (invalid.json as { code?: string }).code]).toEqual([
      503,
      "sandbox_unavailable",
    ]);
  });
});
