import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatApi } from "./api";
import { FakeKobe } from "./testing/fake-kobe";
import { ThreadController } from "./thread-controller";
import { currentRunId, isStopping, liveOverlay, type ThreadState } from "./thread-state";
import { projectThread } from "./tree";

let fake: FakeKobe;
let controllers: ThreadController[];

beforeEach(() => {
  fake = new FakeKobe();
  controllers = [];
  retitles.length = 0;
});
afterEach(() => {
  for (const c of controllers) c.dispose();
});

const retitles: [string, string][] = [];

function open(threadId: string, reopenDelayMs = 0, fetchFn: typeof fetch = fake.fetch) {
  let n = 0;
  const controller = new ThreadController(threadId, {
    api: createChatApi(fake.teamId, fetchFn),
    eventSource: fake.eventSource,
    newKey: () => `k${++n}`,
    reopenDelayMs: () => reopenDelayMs,
    onRetitled: (id, title) => retitles.push([id, title]),
  });
  controllers.push(controller);
  return controller;
}

async function until(controller: ThreadController, check: (s: ThreadState) => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check(controller.getState())) return controller.getState();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `condition not reached: ${JSON.stringify(controller.getState(), null, 1).slice(0, 3000)}`,
  );
}

function visibleTexts(state: ThreadState): string[] {
  const p = projectThread(state.entries, state.summary?.leafEntryId ?? null, liveOverlay(state));
  const byId = new Map(p.items.map((i) => [i.message.id, i] as const));
  const path: string[] = [];
  let id = p.headId;
  while (id !== null) {
    const item = byId.get(id);
    if (!item) break;
    const content = item.message.content;
    const text =
      typeof content === "string"
        ? content
        : content.map((c) => ("text" in c ? c.text : `[${c.type}]`)).join("");
    path.unshift(text);
    id = item.parentId;
  }
  return path;
}

describe("auto-title after the first run (KOBE-219 ac-2, ac-6)", () => {
  it("keeps listening after run.completed and applies thread.updated to the bar and the list", async () => {
    const t = fake.addThread(null);
    const c = open(t);
    await c.load();
    expect(await c.send("What drives revenue?")).toBe(true);
    const runId = fake.latestRun(t).run_id;
    await until(c, (s) => s.connection === "open");
    fake.agent.commitPrompt(runId);
    fake.agent.complete(runId, { epilogue: ["title"] });
    await until(c, (s) => s.live?.terminal !== undefined);
    expect(c.getState().summary?.title ?? null).toBeNull();
    fake.agent.retitle(runId, "Revenue drivers");
    await until(c, (s) => s.summary?.title === "Revenue drivers");
    expect(retitles).toEqual([[t, "Revenue drivers"]]);
    // A later refresh keeps it (the server saved it before the event).
    await c.refresh();
    expect(c.getState().summary?.title).toBe("Revenue drivers");
  });

  it("ignores a thread.updated for another thread", async () => {
    const t = fake.addThread(null);
    const other = fake.addThread(null);
    const c = open(t);
    await c.load();
    await c.send("q");
    const runId = fake.latestRun(t).run_id;
    await until(c, (s) => s.connection === "open");
    fake.agent.complete(runId, { epilogue: ["title"] });
    await until(c, (s) => s.live?.terminal !== undefined);
    fake.emit(runId, "thread.updated", { thread_id: other, title: "Elsewhere" });
    await new Promise((r) => setTimeout(r, 30));
    expect(c.getState().summary?.title ?? null).toBeNull();
    expect(retitles).toEqual([]);
  });
});

describe("ThreadController", () => {
  it("loads, sends, streams and settles on the committed entries", async () => {
    const t = fake.addThread("x");
    const u1 = fake.addEntry(t, null, { role: "user", content: "q1" });
    fake.addEntry(t, u1, { role: "assistant", content: [{ type: "text", text: "a1" }] });
    const c = open(t);
    await c.load();
    expect(visibleTexts(c.getState())).toEqual(["q1", "a1"]);

    expect(await c.send("q2")).toBe(true);
    const runId = fake.latestRun(t).run_id;
    await until(c, (s) => s.connection === "open");
    expect(currentRunId(c.getState())).toBe(runId);
    fake.agent.delta(runId, "m1", "an");
    fake.agent.delta(runId, "m1", "swer");
    await until(c, (s) => s.live?.messages.length === 1 && s.live.lastSeq >= 3);
    expect(visibleTexts(c.getState())).toEqual(["q1", "a1", "q2", "answer"]);

    fake.agent.commitPrompt(runId);
    fake.agent.commit(
      runId,
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      "m1",
    );
    fake.agent.complete(runId);
    await until(
      c,
      (s) => s.live?.terminal !== undefined && s.connection === "idle" && s.serverSeq === 4,
    );
    expect(visibleTexts(c.getState())).toEqual(["q1", "a1", "q2", "answer"]);
    expect(c.getState().entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("reopens a stream the server refused while its run is still active, then gives up visibly", async () => {
    const t = fake.addThread("x");
    const c = open(t, 30);
    await c.load();
    await c.send("go");
    const runId = fake.latestRun(t).run_id;
    await until(c, (s) => s.connection === "open");
    fake.agent.delta(runId, "m1", "a");

    fake.run(runId).compacted = true; // refuses every connection (as a 410 would)
    fake.dropConnections();
    await until(c, (s) => s.connection === "reconnecting");
    fake.run(runId).compacted = false;
    await until(c, (s) => s.connection === "open");
    fake.agent.delta(runId, "m1", "b");
    await until(c, (s) => s.live?.messages[0]?.parts[0]?.kind === "text" && s.live.lastSeq === 3);
    expect(visibleTexts(c.getState()).at(-1)).toBe("ab");

    fake.run(runId).compacted = true;
    fake.dropConnections();
    await until(c, (s) => s.connection === "lost");
    expect(fake.openStreams).toHaveLength(0);
    fake.run(runId).compacted = false;
    c.reconnect();
    await until(c, (s) => s.connection === "open");
  });

  it("sends once per message even when the network fails after the server got it", async () => {
    const t = fake.addThread("x");
    const c = open(t);
    await c.load();
    let calls = 0;
    const flaky: typeof fetch = async (input, init) => {
      const res = await fake.fetch(input, init);
      if (String(input).endsWith("/messages") && ++calls === 1) throw new TypeError("network down");
      return res;
    };
    const c2 = new ThreadController(t, {
      api: createChatApi(fake.teamId, flaky),
      eventSource: fake.eventSource,
      newKey: () => "same-key",
    });
    controllers.push(c2);
    await c2.load();
    expect(await c2.send("only once")).toBe(true);
    expect([...fake.runs.values()].map((r) => r.input)).toEqual(["only once"]);
    expect(
      fake.requests.filter((r) => r.path.endsWith("/messages")).map((r) => r.idempotencyKey),
    ).toEqual(["same-key", "same-key"]);
    expect(c.getState().phase).toBe("ready");
  });

  it("sends on a plain-HTTP origin (no crypto.randomUUID) and recovers from any send failure", async () => {
    const t = fake.addThread("x");
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    try {
      const c = new ThreadController(t, {
        api: createChatApi(fake.teamId, fake.fetch),
        eventSource: fake.eventSource,
      });
      controllers.push(c);
      await c.load();
      expect(await c.send("hello")).toBe(true);
      expect(fake.requests.find((r) => r.path.endsWith("/messages"))?.idempotencyKey).toMatch(
        /^[0-9a-f]{32}$/,
      );
    } finally {
      vi.unstubAllGlobals();
    }

    const broken = new ThreadController(t, {
      api: createChatApi(fake.teamId, fake.fetch),
      eventSource: fake.eventSource,
      newKey: () => {
        throw new Error("no randomness");
      },
    });
    controllers.push(broken);
    await broken.load();
    expect(await broken.send("again")).toBe(false);
    expect(broken.getState().sending).toBeUndefined();
    expect(broken.getState().actionError).toMatchObject({
      draft: "again",
      error: { code: "client_error" },
    });
  });
});

describe("Stop (KOBE-269)", () => {
  /** A thread with a run streaming; cancels go through `onCancel` instead of the fake. */
  async function running(
    onCancel?: (input: RequestInfo | URL, init: RequestInit) => Promise<Response>,
  ) {
    const t = fake.addThread("x");
    const fetchFn: typeof fetch = async (input, init = {}) =>
      onCancel && init.method === "POST" && String(input).includes("/cancel")
        ? onCancel(input, init)
        : fake.fetch(input, init);
    const c = open(t, 0, fetchFn);
    await c.load();
    expect(await c.send("q")).toBe(true);
    const runId = fake.latestRun(t).run_id;
    await until(c, (s) => s.connection === "open" && currentRunId(s) === runId);
    return { c, runId };
  }

  it("counts as stopping from the click, while the cancel is in flight", async () => {
    let answer: (r: Response) => void = () => {};
    const { c, runId } = await running(() => new Promise<Response>((r) => (answer = r)));
    const stopped = c.stop();
    expect(c.getState().stopRequested).toBe(runId);
    expect(isStopping(c.getState())).toBe(true);
    answer(Response.json({ code: "accepted" }, { status: 202 }));
    await stopped;
    expect(isStopping(c.getState())).toBe(true); // the run's end has not arrived yet
  });

  it("a refused cancel clears the flag: the run is still running", async () => {
    const { c } = await running(async () =>
      Response.json({ code: "internal", message: "No." }, { status: 500 }),
    );
    await c.stop();
    expect(c.getState().stopRequested).toBeUndefined();
    expect(isStopping(c.getState())).toBe(false);
  });

  it("the run's end drops the flag", async () => {
    const { c } = await running();
    await c.stop();
    const state = await until(c, (s) => currentRunId(s) === undefined);
    expect(state.stopRequested).toBeUndefined();
  });
});

describe("run events for the notebook panel (KOBE-465)", () => {
  it("hands every streamed batch of the thread's runs to onRunEvents", async () => {
    const seen: [string, string[]][] = [];
    const t = fake.addThread(null);
    const c = new ThreadController(t, {
      api: createChatApi(fake.teamId, fake.fetch),
      eventSource: fake.eventSource,
      newKey: () => "k1",
      reopenDelayMs: () => 0,
      onRunEvents: (id, events) => seen.push([id, events.map((e) => e.type)]),
    });
    controllers.push(c);
    await c.load();
    expect(await c.send("run some code")).toBe(true);
    const runId = fake.latestRun(t).run_id;
    await until(c, (s) => s.connection === "open");
    fake.emit(runId, "notebook.started", {
      exec_id: "00000000-0000-4000-8000-000000000301",
      origin: "agent",
      tool_call_id: "call-1",
    });
    await vi.waitFor(() =>
      expect(seen.some(([id, types]) => id === t && types.includes("notebook.started"))).toBe(true),
    );
  });
});
