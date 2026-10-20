/**
 * Root branches (KOBE-214, CE16): Pi 1.0 writes a settings entry at the root of every session, so a
 * new first message hangs below that hidden entry (and the sandbox agent's `kobe.branch` marker),
 * beside the old one.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { newLiveRun } from "./live";
import { assistant, entry, resetEntrySeq, text, user } from "./testing/entries";
import { branchPoint, EMPTY_VERSION_NOTE, projectThread, type Projection } from "./tree";

beforeEach(() => resetEntrySeq());

function shape(p: Projection) {
  return p.items.map((i) => [i.message.id, i.parentId, i.message.role]);
}

/** A Pi session: settings at the root, one turn, a compaction after it. */
const session = () => [
  entry("r0", null, null, "thinking_level_change"),
  user("u1", "r0", "first"),
  assistant("a1", "u1", text("one")),
  entry("c1", "a1", null, "compaction"),
];

describe("projectThread: root branches (KOBE-214)", () => {
  it("shows the pending prompt of a root edit beside the first message, as the head", () => {
    const p = projectThread(session(), "c1", {
      run: newLiveRun("r1"),
      active: true,
      prompt: { text: "a better start", parentEntryId: "r0" },
    });
    expect(shape(p).at(-1)).toEqual(["prompt:r1", null, "user"]);
    expect(p.headId).toBe("prompt:r1");
  });

  it("shows a queued message's prompt (no parent yet: the leaf it starts on) under the head", () => {
    // The server names a queued message's parent only when its run starts; pending-messages read
    // before that says null. Shown at the root, the thread flashed a one-message branch at the
    // start of every queued run, which re-pinned a list the member had scrolled up (KOBE-415).
    const p = projectThread(session(), "c1", {
      run: newLiveRun("r1"),
      active: true,
      prompt: { text: "queued earlier", parentEntryId: null },
    });
    expect(shape(p)).toEqual([
      ["u1", null, "user"],
      ["a1", "u1", "assistant"],
      ["prompt:r1", "a1", "user"],
    ]);
    expect(p.headId).toBe("prompt:r1");
  });

  it("shows a root edit with no message yet as an empty version, never another root's branch", () => {
    const entries = [...session(), entry("k1", "r0", null, "custom")];
    const p = projectThread(entries, "k1");
    expect(shape(p)).toEqual([
      ["u1", null, "user"],
      ["a1", "u1", "assistant"],
      ["empty:k1", null, "assistant"],
    ]);
    expect(p.headId).toBe("empty:k1");
    expect(p.items.at(-1)?.message.content).toEqual([
      { type: "data-kobe-problem", data: { reason: "empty", message: EMPTY_VERSION_NOTE } },
    ]);
    // Choosing that version again puts the leaf back where the next message continues.
    expect(p.lastEntryOfNode.get("empty:k1")).toBe("k1");
  });

  it("leaves the empty version out while the root edit's prompt is still on screen", () => {
    const entries = [...session(), entry("k1", "r0", null, "custom")];
    const p = projectThread(entries, "k1", {
      run: newLiveRun("r1"),
      active: false,
      prompt: { text: "a better start", parentEntryId: "r0" },
    });
    expect(shape(p).map(([id]) => id)).toEqual(["u1", "a1", "prompt:r1"]);
    expect(p.headId).toBe("prompt:r1");
  });

  it("puts the head on the newest branch below a hidden leaf at the root", () => {
    const entries = [
      ...session(),
      entry("k1", "r0", null, "custom"),
      user("u1b", "k1", "again"),
      assistant("a1b", "u1b", text("two")),
    ];
    expect(projectThread(entries, "r0").headId).toBe("a1b");
    expect(projectThread(entries, "c1").headId).toBe("a1");
  });
});

describe("branchPoint", () => {
  it("branches a first message from Pi's root settings entry", () => {
    const p = projectThread(session(), "c1");
    expect(branchPoint(p, "u1")).toEqual({ parentEntryId: "r0", text: "first" });
  });

  it("offers nothing for a prompt with no entry above it, nor one whose parent is not loaded", () => {
    expect(branchPoint(projectThread([user("u1", null, "q")], "u1"), "u1")).toBeUndefined();
    const paged = projectThread(
      [user("u5", "a4", "later"), assistant("a5", "u5", text("x"))],
      "a5",
    );
    expect(branchPoint(paged, "u5")).toBeUndefined();
  });

  it("offers nothing for an answer or a prompt Pi hasn't committed", () => {
    const p = projectThread(session(), "c1", {
      run: newLiveRun("r1"),
      active: true,
      prompt: { text: "next", parentEntryId: "c1" },
    });
    expect(branchPoint(p, "a1")).toBeUndefined();
    expect(branchPoint(p, "prompt:r1")).toBeUndefined();
    expect(branchPoint(p, undefined)).toBeUndefined();
  });
});
