import { describe, expect, it } from "vitest";
import { promptPrefix, promptSourceOf } from "./run-prompt.js";

const t = "2026-10-15T10:00:00.000Z";
const RUN = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6072";
const user = (id: string, parentId: string | null) => ({
  type: "message",
  id,
  parentId,
  timestamp: t,
  message: { role: "user", content: [] },
});
const answer = (id: string, parentId: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: t,
  message: { role: "assistant", content: [], stopReason: "aborted" },
});
const marker = (id: string, parentId: string, runId: string) => ({
  type: "custom",
  id,
  parentId,
  timestamp: t,
  customType: "kobe.branch",
  data: { run_id: runId },
});

describe("the prompt in Pi's new entries (KOBE-290)", () => {
  it("cuts after the first user message: setup entries kept, the aborted answer not", () => {
    const setup = { type: "model_change", id: "m1", parentId: null, timestamp: t };
    const entries = [setup, user("u1", "m1"), answer("a1", "u1")];
    expect(promptPrefix(entries, RUN)?.map((e) => e.id)).toEqual(["m1", "u1"]);
  });

  it("takes the user message after the run's own branch marker, not an older leftover", () => {
    const entries = [
      user("old", "p0"),
      answer("a0", "old"),
      marker("k1", "p0", RUN),
      user("u1", "k1"),
      answer("a1", "u1"),
    ];
    expect(promptPrefix(entries, RUN)?.map((e) => e.id)).toEqual(["old", "a0", "k1", "u1"]);
  });

  it("finds no prompt when Pi has none (only the run's branch marker, or nothing)", () => {
    const entries = [marker("k1", "p0", RUN)];
    expect(promptPrefix(entries, RUN)).toBeUndefined();
    expect(promptPrefix([], RUN)).toBeUndefined();
    expect(promptSourceOf({ entries, leafId: "k1" }, RUN)).toEqual({ kind: "never_reached_pi" });
    expect(promptSourceOf({ entries: [user("u1", null)], leafId: "u1" }, RUN).kind).toBe("pi");
  });
});
