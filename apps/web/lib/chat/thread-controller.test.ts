import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChatApi } from "./api";
import { FakeKobe } from "./testing/fake-kobe";
import { ThreadController } from "./thread-controller";
import { currentRunId, liveOverlay, type ThreadState } from "./thread-state";
import { projectThread } from "./tree";

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
});
