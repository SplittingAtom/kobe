import { describe, expect, it } from "vitest";
import { entryMarkdown, inline, threadHeader } from "./export-markdown.js";

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

  it("renders an app card's text only: never its details (KOBE-440, MA10)", () => {
    const card = entryMarkdown({
      type: "custom_message",
      id: "ka-000000000000000000000001",
      parentId: "e1",
      timestamp: "2026-10-01T10:00:00.000Z",
      customType: "kobe.app_card",
      content: "The app-card block below…\n<app-card>3 tables</app-card>",
      display: true,
      details: { tool: "open_explorer", result_ref: "secret-ref" },
    });
    expect(card).toContain("**App opened by the member:** `open_explorer`");
    expect(card).toContain("3 tables");
    expect(card).not.toContain("secret-ref");
    expect(entryMarkdown({ type: "custom_message", customType: "kobe.branch" })).toBeNull();
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
});

describe("threadHeader title (KOBE-219 review L3)", () => {
  it("escapes Markdown in the heading, so a title cannot become a link or markup", () => {
    const header = threadHeader({
      threadId: "t1",
      title: "[click](javascript:alert(1)) *bold* <b>x</b>",
      createdAt: "2026-10-16T00:00:00Z",
      lastActivityAt: "2026-10-16T00:00:00Z",
      inTrash: false,
    });
    const heading = header.split("\n")[0] ?? "";
    expect(heading).toBe("# \\[click\\]\\(javascript:alert\\(1\\)\\) \\*bold\\* \\<b\\>x\\</b\\>");
  });
});

describe("MCP Apps context in exports (KOBE-439 ac-3)", () => {
  it("keeps the fenced, untrusted block of a sent message", async () => {
    const { withAppContext } = await import("../apps/context-block.js");
    const text = withAppContext(
      [{ connectorName: "Catalyst", data: { structuredContent: { table: "c.n.t" } } }],
      "What is in it?",
    );
    const md = entryMarkdown({ type: "message", message: { role: "user", content: text } });
    expect(md).toContain('<app-context source="connector:Catalyst" untrusted="true">');
    expect(md).toContain("What is in it?");
  });
});
