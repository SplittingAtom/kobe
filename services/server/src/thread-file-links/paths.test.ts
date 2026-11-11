import { describe, expect, it } from "vitest";
import { usesFromRows } from "./backfill.js";
import { projectMountPath, toolCallLink, workspaceRelative } from "./paths.js";

describe("toolCallLink (KOBE-610, TFM1/TFM2)", () => {
  it("links file tools by access, paths normalised to the workspace root", () => {
    expect(toolCallLink("read", { path: "/workspace/notes/a.md" })).toEqual({
      access: "read",
      path: "notes/a.md",
    });
    expect(toolCallLink("write", { path: "notes/./b.md", content: "x" })).toEqual({
      access: "write",
      path: "notes/b.md",
    });
    expect(toolCallLink("edit", { path: "/workspace/x/../c.md", edits: [] })).toEqual({
      access: "write",
      path: "c.md",
    });
    for (const tool of ["ls", "find", "grep", "share_file", "open_file", "propose_file_edit"]) {
      expect(toolCallLink(tool, { path: "data", pattern: "*" })?.access).toBe("read");
    }
    expect(toolCallLink("run_python", { path: "nb.ipynb" })?.access).toBe("write");
  });

  it("ignores bash, unknown tools, paths outside /workspace and agent-internal paths", () => {
    expect(toolCallLink("bash", { command: "cat /workspace/a.md" })).toBeUndefined();
    expect(toolCallLink("mcp__x__read", { path: "a.md" })).toBeUndefined();
    expect(toolCallLink("read", { path: "/etc/passwd" })).toBeUndefined();
    expect(toolCallLink("read", { path: "../etc/passwd" })).toBeUndefined();
    expect(toolCallLink("read", { path: "/workspace" })).toBeUndefined();
    expect(toolCallLink("ls", {})).toBeUndefined();
    expect(toolCallLink("read", { path: "/workspace/.kobe/session.jsonl" })).toBeUndefined();
    expect(toolCallLink("read", { path: "~/a.md" })).toBeUndefined();
    expect(toolCallLink("read", { path: 7 })).toBeUndefined();
    expect(toolCallLink("read", null)).toBeUndefined();
    expect(workspaceRelative("/workspacex/a")).toBeUndefined();
  });

  it("splits a project mount path into slug and inner path", () => {
    expect(projectMountPath("projects/docs/guide/a.md")).toEqual({
      slug: "docs",
      inner: "guide/a.md",
    });
    expect(projectMountPath("projects/docs")).toBeUndefined();
    expect(projectMountPath("projects/docs/")).toBeUndefined();
    expect(projectMountPath("notes/projects/docs/a")).toBeUndefined();
  });
});

describe("usesFromRows (backfill, TFM3)", () => {
  const at = "2026-11-01T00:00:00Z";
  const call = (id: string, tool: string, args: unknown) =>
    ({ kind: "call", call_id: id, tool, args, is_error: null, at }) as const;
  const result = (id: string, tool: string, isError: boolean) =>
    ({ kind: "result", call_id: id, tool, args: null, is_error: String(isError), at }) as const;

  it("keeps calls answered without error, drops errors, unanswered calls and bash", () => {
    const uses = usesFromRows([
      call("1", "read", { path: "a.md" }),
      result("1", "read", false),
      call("2", "write", { path: "b.md", content: "" }),
      result("2", "write", true),
      call("3", "edit", { path: "c.md", edits: [] }),
      call("4", "bash", { command: "cat d.md" }),
      result("4", "bash", false),
      // A model id reused later in the thread answers its latest call.
      call("1", "write", { path: "e.md", content: "" }),
      result("1", "write", false),
    ]);
    expect(uses.map((u) => `${u.access}:${u.path}`)).toEqual(["read:a.md", "write:e.md"]);
  });
});
