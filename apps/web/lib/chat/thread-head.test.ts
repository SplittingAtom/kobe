import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChatApi } from "./api";
import { headOf, isBrowsing } from "./head";
import { FakeKobe } from "./testing/fake-kobe";
import { ThreadController } from "./thread-controller";
import { liveOverlay, type ThreadState } from "./thread-state";
import { projectThread } from "./tree";

/** The local head in the controller (CT3, CT13, CT15; KOBE-544). */
let fake: FakeKobe;
let controllers: ThreadController[];

beforeEach(() => {
  fake = new FakeKobe();
  controllers = [];
});
afterEach(() => {
  for (const c of controllers) c.dispose();
});

function open(threadId: string) {
  let n = 0;
  const controller = new ThreadController(threadId, {
    api: createChatApi(fake.teamId, fake.fetch),
    eventSource: fake.eventSource,
    newKey: () => `k${++n}`,
    reopenDelayMs: () => 0,
    resumeStore: null,
  });
  controllers.push(controller);
  return controller;
}

async function until(controller: ThreadController, check: (s: ThreadState) => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check(controller.getState())) return controller.getState();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`condition not reached: ${JSON.stringify(controller.getState()).slice(0, 2000)}`);
}

/** The texts on screen, root to head, projected from the head as the runtime does. */
function onScreen(state: ThreadState): string[] {
  const overlay = isBrowsing(state) ? undefined : liveOverlay(state);
  const p = projectThread(state.entries, headOf(state), overlay);
  const byId = new Map(p.items.map((i) => [i.message.id, i] as const));
  const path: string[] = [];
  for (let id = p.headId; id !== null;) {
    const item = byId.get(id);
    if (!item) break;
    const c = item.message.content;
    path.unshift(typeof c === "string" ? c : c.map((x) => ("text" in x ? x.text : "")).join(""));
    id = item.parentId;
  }
  return path;
}

/** start → a1 → (old question → old answer | new question → new answer, the leaf). */
function branched() {
  const t = fake.addThread("Branches");
  const u1 = fake.addEntry(t, null, { role: "user", content: "start" });
  const a1 = fake.addEntry(t, u1, { role: "assistant", content: [{ type: "text", text: "a1" }] });
  const u2 = fake.addEntry(t, a1, { role: "user", content: "old question" });
  const a2 = fake.addEntry(t, u2, {
    role: "assistant",
    content: [{ type: "text", text: "old answer" }],
  });
  const u2b = fake.addEntry(t, a1, { role: "user", content: "new question" });
  const a2b = fake.addEntry(t, u2b, {
    role: "assistant",
    content: [{ type: "text", text: "new answer" }],
  });
  return { t, a1, u2, a2, u2b, a2b };
}

const leafCalls = () => fake.requests.filter((r) => r.path.endsWith("/leaf"));

async function opened(t: string) {
  const c = open(t);
  await c.load();
  return c;
}

describe("the local head (CT3)", () => {
  it("starts at the leaf; showing another branch moves only the head", async () => {
    const { t, u2, a2, a2b } = branched();
    const c = await opened(t);
    expect(headOf(c.getState())).toBe(a2b);
    c.showBranch(u2);
    const s = c.getState();
    expect(s.head).toBe(a2);
    expect(s.summary?.leafEntryId).toBe(a2b);
    expect(onScreen(s)).toEqual(["start", "a1", "old question", "old answer"]);
    expect(s.announcement).toBe("Showing another branch");
    expect(leafCalls()).toEqual([]);
    c.showLeaf();
    expect(c.getState().head).toBeUndefined();
    expect(onScreen(c.getState()).at(-1)).toBe("new answer");
  });

  it("Make it current posts the head's branch leaf once and the head follows the leaf", async () => {
    const { t, a2 } = branched();
    const c = await opened(t);
    c.showVersion(a2);
    const res = await c.makeCurrent();
    expect(res?.ok).toBe(true);
    expect(leafCalls().map((r) => r.body)).toEqual([{ entry_id: a2 }]);
    const s = c.getState();
    expect(s.summary?.leafEntryId).toBe(a2);
    expect(s.head).toBeUndefined();
    expect(isBrowsing(s)).toBe(false);
    expect(s.announcement).toBe("This branch is now current");
    expect(fake.threads.get(t)?.leaf_entry_id).toBe(a2);
  });

  it("a queued run refuses Make it current with thread_busy; nothing retries, the head stays", async () => {
    const { t, a2, a2b } = branched();
    const c = await opened(t);
    await c.send("long task");
    await c.send("queued task");
    await until(c, (s) => s.runs.some((r) => r.status === "queued"));
    c.showVersion(a2);
    const res = await c.makeCurrent();
    expect(res).toMatchObject({ ok: false, error: { code: "thread_busy" } });
    expect(leafCalls()).toHaveLength(1);
    expect(c.getState().head).toBe(a2);
    expect(c.getState().actionError).toBeUndefined();
    expect(fake.threads.get(t)?.leaf_entry_id).toBe(a2b);
  });

  it("a reader's thread never posts the leaf", async () => {
    const { t, a2 } = branched();
    Object.assign(fake.threads.get(t) ?? {}, { read_only: true });
    const c = await opened(t);
    c.showVersion(a2);
    expect(await c.makeCurrent()).toBeUndefined();
    expect(onScreen(c.getState()).at(-1)).toBe("old answer");
    expect(leafCalls()).toEqual([]);
  });

  it("a send from a browsed branch continues the head and the head follows the new leaf", async () => {
    const { t, a2 } = branched();
    const c = await opened(t);
    c.showVersion(a2);
    expect(await c.send("go on here")).toBe(true);
    const post = fake.requests.find((r) => r.path.endsWith("/messages"));
    expect(post?.body).toEqual({ content: "go on here", parent_entry_id: a2 });
    expect(c.getState().head).toBeUndefined();
    expect(onScreen(c.getState())).toEqual([
      "start",
      "a1",
      "old question",
      "old answer",
      "go on here",
    ]);
    const run = fake.latestRun(t);
    fake.agent.commitPrompt(run.run_id);
    const answer = fake.agent.commit(run.run_id, {
      role: "assistant",
      content: [{ type: "text", text: "here it is" }],
    });
    fake.agent.complete(run.run_id);
    const s = await until(c, (st) => st.summary?.leafEntryId === answer);
    expect(onScreen(s).slice(-2)).toEqual(["go on here", "here it is"]);
    expect(leafCalls()).toEqual([]);
  });

  it("a send on the leaf's branch still continues from the leaf without a parent", async () => {
    const { t } = branched();
    const c = await opened(t);
    await c.send("next");
    expect(fake.requests.find((r) => r.path.endsWith("/messages"))?.body).toEqual({
      content: "next",
    });
  });
});

describe("the leaf on the wire (CT13)", () => {
  it("a head at the old leaf follows the new leaf; a browsed head stays", async () => {
    const { t, a2 } = branched();
    const following = await opened(t);
    const browsing = await opened(t);
    browsing.showVersion(a2);
    await following.send("work");
    const run = fake.latestRun(t);
    await browsing.refresh(); // the other tab streams the run too
    const u3 = fake.agent.commitPrompt(run.run_id);
    await until(following, (s) => s.entries.some((e) => e.entryId === u3));
    await until(browsing, (s) => s.entries.some((e) => e.entryId === u3));
    fake.agent.leafMoved(run.run_id, u3);
    await until(following, (s) => s.summary?.leafEntryId === u3);
    expect(headOf(following.getState())).toBe(u3);
    expect(following.getState().head).toBeUndefined();
    const other = await until(browsing, (s) => s.summary?.leafEntryId === u3);
    expect(other.head).toBe(a2);
    expect(onScreen(other).at(-1)).toBe("old answer");
  });

  it("a title-only update leaves the leaf alone", async () => {
    const { t, a2b } = branched();
    const c = await opened(t);
    await c.send("work");
    const run = fake.latestRun(t);
    fake.agent.retitle(run.run_id, "Renamed");
    await until(c, (s) => s.summary?.title === "Renamed");
    expect(c.getState().summary?.leafEntryId).toBe(a2b);
  });
});

describe("search hits open on their branch (CT15)", () => {
  it("a hit off the leaf's branch moves the head there and asks to scroll to it", async () => {
    const { t, u2, a2, a2b } = branched();
    const c = open(t);
    c.showHit(u2); // before the read: applied once the entries are in
    await c.load();
    const s = c.getState();
    expect(s.head).toBe(a2);
    expect(s.reveal).toEqual({ entryId: u2, seq: 1 });
    expect(s.summary?.leafEntryId).toBe(a2b);
    expect(leafCalls()).toEqual([]);
  });

  it("a hit on the leaf's branch scrolls without moving the head", async () => {
    const { t, a1 } = branched();
    const c = await opened(t);
    c.showHit(a1);
    expect(c.getState().head).toBeUndefined();
    expect(c.getState().reveal?.entryId).toBe(a1);
  });
});
