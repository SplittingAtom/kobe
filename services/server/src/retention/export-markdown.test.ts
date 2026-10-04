import { describe, expect, it } from "vitest";
import { activeBranch, entryMarkdown, inline, threadHeader } from "./export-markdown.js";

const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "message",
  id: "e1",
  parentId: null,
  timestamp: "2026-10-01T10:00:00.000Z",
  message: { role, content, ...extra },
});

describe("export Markdown", () => {
  it("renders user and assistant turns, tool calls and results", () => {
    expect(entryMarkdown(message("user", "Plot Q3 revenue"))).toBe(
      "### You · 2026-10-01T10:00:00.000Z\n\nPlot Q3 revenue",
    );
    const assistant = entryMarkdown(
      message("assistant", [
        { type: "thinking", thinking: "secret plan" },
        { type: "text", text: "Here it is." },
        { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
      ]),
    );
    expect(assistant).toContain("Here it is.");
    expect(assistant).toContain("**Tool call:** `bash`");
    expect(assistant).toContain('"command": "ls"');
    expect(assistant).not.toContain("secret plan");
    const result = entryMarkdown(
      message("toolResult", [{ type: "text", text: "a.csv" }], { toolName: "bash", isError: true }),
    );
    expect(result).toContain("**Tool result:** `bash` (error)");
    expect(result).toContain("a.csv");
  });

  it("skips entries that are not conversation turns or are malformed", () => {
    expect(entryMarkdown({ type: "model_change", id: "x" })).toBeNull();
    expect(entryMarkdown({ type: "message" })).toBeNull();
    expect(entryMarkdown(null)).toBeNull();
    expect(entryMarkdown(message("assistant", "not parts"))).toBeNull();
  });

  it("fences tool output so it can't close its code block", () => {
    const out = entryMarkdown(
      message("toolResult", "```\n# injected heading\n```", { toolName: "bash" }),
    );
    expect(out).toContain("````\n```\n# injected heading\n```\n````");
  });

  it("keeps titles on one line", () => {
    expect(inline("a\nb\r\tc\u0007")).toBe("a b c");
    expect(
      threadHeader({
        threadId: "t1",
        title: "## Budget\nplan",
        createdAt: "c",
        lastActivityAt: "l",
        inTrash: true,
      }),
    ).toMatch(/^# Budget plan\n[\s\S]*- In Trash\n$/);
    expect(
      threadHeader({
        threadId: "t",
        title: null,
        createdAt: "c",
        lastActivityAt: "l",
        inTrash: false,
      }),
    ).toContain("# Untitled conversation");
  });

  it("follows the active branch from the leaf, and survives cycles", () => {
    const parents = new Map<string, string | null>([
      ["a", null],
      ["b", "a"],
      ["c", "a"],
      ["d", "c"],
    ]);
    expect([...activeBranch(parents, "d")].sort()).toEqual(["a", "c", "d"]);
    expect(activeBranch(parents, null).size).toBe(0);
    const loop = new Map<string, string | null>([
      ["x", "y"],
      ["y", "x"],
    ]);
    expect(activeBranch(loop, "x").size).toBe(2);
  });
});
