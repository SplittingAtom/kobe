import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { must } from "../testing/must";
import { createChatApi } from "./api";
import { FakeKobe } from "./testing/fake-kobe";
import { ThreadController } from "./thread-controller";
import { canRegenerateWith, initialThreadState, type ThreadState } from "./thread-state";
import type { ThreadSummary } from "./types";

/** KOBE-217: `ThreadController.regenerateWith` and when it may run (`canRegenerateWith`). */
let fake: FakeKobe;
let controllers: ThreadController[];

beforeEach(() => {
  fake = new FakeKobe();
  fake.teamModels.push(
    { alias: "kimi", label: "Kimi", enabled: true, is_default: true },
    { alias: "glm", label: "GLM", enabled: true, is_default: false },
  );
  controllers = [];
});
afterEach(() => {
  for (const c of controllers) c.dispose();
});

function open(threadId: string, fetchFn: typeof fetch = fake.fetch) {
  let n = 0;
  const controller = new ThreadController(threadId, {
    api: createChatApi(fake.teamId, fetchFn),
    eventSource: fake.eventSource,
    newKey: () => `k${++n}`,
    reopenDelayMs: () => 0,
  });
  controllers.push(controller);
  return controller;
}

function oneTurn() {
  const t = fake.addThread("x");
  const root = fake.addSystemEntry(t, null, "thinking_level_change", { thinkingLevel: "off" });
  const u1 = fake.addEntry(t, root, { role: "user", content: "q1" });
  fake.addEntry(t, u1, { role: "assistant", content: [{ type: "text", text: "a1" }] });
  return { t, root };
}

const requests = (method: string, suffix: string) =>
  fake.requests.filter((r) => r.method === method && r.path.endsWith(suffix));

describe("canRegenerateWith", () => {
  const idle: ThreadState = {
    ...initialThreadState("t1"),
    phase: "ready",
    summary: { threadId: "t1", model: null, deletedAt: null } as unknown as ThreadSummary,
  };

  it("allows an idle, read thread out of Trash", () => {
    expect(canRegenerateWith(idle)).toBe(true);
  });

  it.each<[string, Partial<ThreadState>]>([
    ["not read yet", { summary: undefined }],
    ["loading", { phase: "loading" }],
    ["in Trash", { summary: { ...idle.summary, deletedAt: "2026-10-14" } as ThreadSummary }],
    [
      "a run going",
      { runs: [{ runId: "r1", threadId: "t1", status: "running", trigger: "user" }] },
    ],
    [
      "a run queued",
      { runs: [{ runId: "r1", threadId: "t1", status: "queued", trigger: "user" }] },
    ],
    [
      "a message being sent",
      { sending: { key: "k", text: "q", parentEntryId: null, queues: false } },
    ],
    ["a model change in flight", { busy: ["model"] }],
  ])("refuses with %s", (_name, change) => {
    expect(canRegenerateWith({ ...idle, ...change })).toBe(false);
  });
});

describe("ThreadController.regenerateWith (KOBE-217)", () => {
  it("saves the model, then sends the question from the branch point", async () => {
    const { t, root } = oneTurn();
    const c = open(t);
    await c.load();
    expect(await c.regenerateWith("glm", "q1", root)).toBe(true);
    expect(fake.threads.get(t)?.model).toBe("glm");
    expect(requests("POST", "/messages").map((r) => r.body)).toEqual([
      { content: "q1", parent_entry_id: root },
    ]);
  });

  it("names the prompt so its run's viewed file goes again (KOBE-467)", async () => {
    const { t, root } = oneTurn();
    const c = open(t);
    await c.load();
    expect(await c.regenerateWith("glm", "q1", root, "u1")).toBe(true);
    expect(requests("POST", "/messages").map((r) => r.body)).toEqual([
      { content: "q1", parent_entry_id: root, viewing_from_entry: "u1" },
    ]);
  });

  it("a second choice while the first is in flight does nothing (no race)", async () => {
    const { t, root } = oneTurn();
    const c = open(t);
    await c.load();
    const first = c.regenerateWith("glm", "q1", root);
    const second = c.regenerateWith("kimi", "q1", root);
    expect(await second).toBe(false);
    expect(await first).toBe(true);
    expect(requests("PATCH", `/threads/${t}`).map((r) => r.body)).toEqual([{ model: "glm" }]);
    expect(requests("POST", "/messages")).toHaveLength(1);
  });

  it("the team default keeps following the default: null, never its alias", async () => {
    const { t, root } = oneTurn();
    must(fake.threads.get(t)).model = "glm";
    const c = open(t);
    await c.load();
    expect(await c.regenerateWith(null, "q1", root)).toBe(true);
    expect(requests("PATCH", `/threads/${t}`).map((r) => r.body)).toEqual([{ model: null }]);
    expect(fake.threads.get(t)?.model).toBeNull();
  });

  it("a refused model runs nothing", async () => {
    const { t, root } = oneTurn();
    const c = open(t);
    await c.load();
    must(fake.teamModels[1]).enabled = false;
    expect(await c.regenerateWith("glm", "q1", root)).toBe(false);
    expect(c.getState().actionError?.error.code).toBe("model_not_enabled");
    expect(requests("POST", "/messages")).toHaveLength(0);
  });

  it("a message that doesn't go puts the previous model back and keeps the failure shown", async () => {
    const { t, root } = oneTurn();
    const c = open(t);
    await c.load();
    fake.failNext.set(
      `POST /v1/threads/${t}/messages`,
      new Response(JSON.stringify({ code: "internal", message: "Server broke." }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await c.regenerateWith("glm", "q1", root)).toBe(false);
    expect(requests("PATCH", `/threads/${t}`).map((r) => r.body)).toEqual([
      { model: "glm" },
      { model: null },
    ]);
    expect(fake.threads.get(t)?.model).toBeNull();
    expect(c.getState().summary?.model).toBeNull();
    expect(c.getState().actionError?.error.status).toBe(500);
  });

  it("a model change that throws is reported, and nothing is sent", async () => {
    const { t, root } = oneTurn();
    const throwing: typeof fetch = (input, init) =>
      init?.method === "PATCH" ? Promise.reject(new TypeError("offline")) : fake.fetch(input, init);
    const c = open(t, throwing);
    await c.load();
    expect(await c.regenerateWith("glm", "q1", root)).toBe(false);
    expect(c.getState().actionError).toBeDefined();
    expect(requests("POST", "/messages")).toHaveLength(0);
    expect(fake.threads.get(t)?.model).toBeNull();
  });
});
