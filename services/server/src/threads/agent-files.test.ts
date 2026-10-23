import { describe, expect, it } from "vitest";
import { orderedAgentFiles, succeededWrites, type ToolRow } from "./agent-files.js";

const call = (
  id: string,
  path: string | null,
  at: number,
  tool = "write",
  scope = "r1",
): ToolRow => ({
  kind: "call",
  scope,
  callId: id,
  tool,
  path,
  at,
});
const result = (
  id: string,
  at: number,
  isError = false,
  tool = "write",
  scope = "r1",
): ToolRow => ({
  kind: "result",
  scope,
  callId: id,
  tool,
  isError,
  at,
});

describe("succeededWrites", () => {
  it("keeps write and edit calls whose result succeeded, normalised, at the call's time", () => {
    const rows = [
      call("a", "/workspace/budget.html", 1),
      result("a", 2),
      call("b", "notes.md", 3, "edit"),
      result("b", 4, false, "edit"),
      call("c", "failed.md", 5),
      result("c", 6, true),
      call("d", "pending.md", 7),
    ];
    expect(succeededWrites(rows)).toEqual([
      { path: "budget.html", at: 1 },
      { path: "notes.md", at: 3 },
    ]);
  });

  it("drops other tools, paths outside /workspace, and calls without a path", () => {
    const rows = [
      call("a", "/etc/passwd", 1),
      result("a", 2),
      call("b", null, 3),
      result("b", 4),
      call("c", "x.md", 5, "bash"),
      result("c", 6, false, "bash"),
      call("d", "../up.md", 7),
      result("d", 8),
    ];
    expect(succeededWrites(rows)).toEqual([]);
  });
});

describe("pairing by scope and order", () => {
  it("never pairs a call with a result of the same id from another run", () => {
    const rows = [
      call("call_0", "a.md", 1, "write", "r1"),
      result("call_0", 2, true, "write", "r1"),
      call("call_0", "b.md", 3, "write", "r2"),
      result("call_0", 4, false, "write", "r2"),
    ];
    expect(succeededWrites(rows)).toEqual([{ path: "b.md", at: 3 }]);
  });

  it("pairs a result with the latest call before it when ids repeat in one scope", () => {
    const rows = [
      call("call_0", "a.md", 1, "write", ""),
      result("call_0", 2, true, "write", ""),
      call("call_0", "b.md", 3, "write", ""),
      result("call_0", 4, false, "write", ""),
    ];
    expect(succeededWrites(rows)).toEqual([{ path: "b.md", at: 3 }]);
  });
});

describe("orderedAgentFiles", () => {
  it("de-duplicates by first appearance and caps the list", () => {
    const out = orderedAgentFiles(
      [
        { path: "b.md", at: 5 },
        { path: "a.md", at: 1 },
        { path: "b.md", at: 2 },
        { path: "c.md", at: 9 },
      ],
      2,
    );
    expect(out).toEqual(["a.md", "b.md"]);
  });
});
