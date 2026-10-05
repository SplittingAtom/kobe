import { describe, expect, it } from "vitest";
import { builtin, mcpTool, SAMPLE_INPUTS } from "../testing/policy-fixtures.js";
import { BUILTIN_INPUT_SCHEMAS, canonicalPath, prepareInput } from "./tool-inputs.js";

describe("canonicalPath (as Pi resolves paths against /workspace)", () => {
  it.each([
    ["notes.md", "/workspace/notes.md"],
    ["./a/./b", "/workspace/a/b"],
    ["a//b/", "/workspace/a/b"],
    ["../etc/passwd", "/etc/passwd"],
    ["../../../../etc", "/etc"],
    ["/workspace/../etc", "/etc"],
    ["//etc//passwd", "/etc/passwd"],
    [".", "/workspace"],
    ["/", "/"],
    ["a\\b", "/workspace/a\\b"], // backslash is a filename character on Linux
  ])("%j → %j", (input, expected) => {
    expect(canonicalPath(input)).toBe(expected);
  });

  it.each(["", "~", "~/x", "~root/x", "@x", "@/etc", "file:///etc", "FILE:/x", "a b", "a　"])(
    "refuses %j (Pi would rewrite it)",
    (input) => {
      expect(canonicalPath(input)).toBeUndefined();
    },
  );
});

describe("prepareInput", () => {
  it("accepts a valid sample for every built-in with a schema", () => {
    for (const name of Object.keys(BUILTIN_INPUT_SCHEMAS)) {
      const result = prepareInput(builtin(name), SAMPLE_INPUTS[name] ?? {});
      expect(result.ok, name).toBe(true);
    }
  });

  it("rewrites only the view's path; other keys stay", () => {
    const result = prepareInput(builtin("read"), { path: "a/../b.md", offset: 3 });
    expect(result).toEqual({ ok: true, view: { path: "/workspace/b.md", offset: 3 } });
  });

  it("fills an omitted path with the cwd only for tools that default to it", () => {
    expect(prepareInput(builtin("ls"), {})).toEqual({ ok: true, view: { path: "/workspace" } });
    expect(prepareInput(builtin("find"), { pattern: "x" })).toMatchObject({
      view: { path: "/workspace" },
    });
  });

  it("checks types, not just keys", () => {
    expect(prepareInput(builtin("bash"), { command: ["rm", "-rf"] }).ok).toBe(false);
    expect(prepareInput(builtin("edit"), { path: "a", edits: [{ oldText: "a" }] }).ok).toBe(false);
    expect(
      prepareInput(builtin("edit"), { path: "a", edits: [{ oldText: "a", newText: "b", x: 1 }] })
        .ok,
    ).toBe(false);
  });

  it("canonicalises kobe-tools' string paths, passes other kobe input as is", () => {
    expect(prepareInput(builtin("share_file"), { path: "out/x.csv" })).toEqual({
      ok: true,
      view: { path: "/workspace/out/x.csv" },
    });
    expect(prepareInput(builtin("share_file"), { path: "~/x" }).ok).toBe(false);
    expect(prepareInput(builtin("remember"), { anything: 1 }).ok).toBe(true);
  });

  it("checks the artifact tools against the published strict schemas (KOBE-127)", () => {
    const create = builtin("create_artifact");
    expect(prepareInput(create, { kind: "svg", title: "T", content: "<svg/>" }).ok).toBe(true);
    expect(prepareInput(create, { anything: 1 }).ok).toBe(false);
    expect(prepareInput(create, { kind: "tsx", title: "T", content: "x" }).ok).toBe(false);
    expect(prepareInput(create, { kind: "markdown", title: "T", content: "x", extra: 1 }).ok).toBe(
      false,
    );
    expect(
      prepareInput(create, { kind: "markdown", title: "T", content: "x", language: "python" }).ok,
    ).toBe(false);
    expect(
      prepareInput(create, { kind: "code", title: "T", content: "x", language: "python" }).ok,
    ).toBe(true);
    expect(
      prepareInput(create, { kind: "csv", title: "T", content: "a".repeat(512 * 1024 + 1) }).ok,
    ).toBe(false);
    const update = builtin("update_artifact");
    expect(prepareInput(update, { artifact_id: "nope", content: "x" }).ok).toBe(false);
    expect(
      prepareInput(update, { artifact_id: "5b1c0f52-8f6e-4a34-9d57-3a6e0c1f2b44", content: "x" })
        .ok,
    ).toBe(true);
  });

  it("leaves MCP inputs to the MCP proxy's pinned schema", () => {
    const tool = mcpTool("mcp__fs__read", "read");
    expect(prepareInput(tool, { path: "~/x" })).toEqual({ ok: true, view: { path: "~/x" } });
  });
});
