import { describe, expect, it } from "vitest";
import {
  CAPABILITY_MEMORY,
  MEMORY_FILE_MAX_BYTES,
  MEMORY_INDEX_FILE,
  MEMORY_INDEX_MAX_LINES,
  SANDBOX_WIRE_VERSION,
  decodeSandboxFrame,
  decodeServerFrame,
  EVENT_PAYLOAD_SCHEMAS,
  memoryDocDetailSchema,
  memoryListResponseSchema,
  memoryPathSchema,
  memorySettingsSchema,
  memoryToolInputSchema,
  memoryToolsRequestSchema,
  memoryToolsResponseSchema,
  recallInputSchema,
  rememberInputSchema,
  runMemoryContextSchema,
  runStartFrameSchema,
  undoMemoryAction,
} from "./index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const TS = "2026-10-09T10:00:00Z";

describe("memory paths", () => {
  it("accepts index and topic files", () => {
    for (const p of ["MEMORY.md", "style.md", "people/anna.md", "a/b/c/d.md"])
      expect(memoryPathSchema.safeParse(p).success, p).toBe(true);
  });
  it("rejects traversal, absolute, odd segments, non-md and depth", () => {
    for (const p of [
      "",
      "/a.md",
      "../a.md",
      "a/../b.md",
      "a//b.md",
      "a.txt",
      ".hidden.md",
      "a b.md",
      "a\\b.md",
      "a/b/c/d/e.md",
      "a..b.md",
      "x".repeat(300) + ".md",
    ])
      expect(memoryPathSchema.safeParse(p).success, p).toBe(false);
  });
  it("names the index", () => {
    expect(MEMORY_INDEX_FILE).toBe("MEMORY.md");
    expect(MEMORY_INDEX_MAX_LINES).toBe(200);
    expect(CAPABILITY_MEMORY).toBe("memory");
  });
});

describe("remember / recall inputs", () => {
  it("remember defaults mode by omission and is strict", () => {
    expect(
      rememberInputSchema.safeParse({ scope: "user", path: "a.md", content: "x" }).success,
    ).toBe(true);
    expect(
      rememberInputSchema.safeParse({
        scope: "project",
        path: "a.md",
        content: "x",
        mode: "append",
      }).success,
    ).toBe(true);
    expect(
      rememberInputSchema.safeParse({ scope: "team", path: "a.md", content: "x" }).success,
    ).toBe(false);
    expect(
      rememberInputSchema.safeParse({ scope: "user", path: "a.md", content: "x", mode: "x" })
        .success,
    ).toBe(false);
    expect(
      rememberInputSchema.safeParse({ scope: "user", path: "a.md", content: "x", extra: 1 })
        .success,
    ).toBe(false);
  });
  it("caps content bytes and the index lines", () => {
    const big = "é".repeat(MEMORY_FILE_MAX_BYTES / 2 + 1);
    expect(
      rememberInputSchema.safeParse({ scope: "user", path: "a.md", content: big }).success,
    ).toBe(false);
    const lines = (n: number) => Array.from({ length: n }, () => "- x").join("\n");
    const idx = (n: number) => ({ scope: "user", path: "MEMORY.md", content: lines(n) });
    expect(rememberInputSchema.safeParse(idx(MEMORY_INDEX_MAX_LINES)).success).toBe(true);
    expect(rememberInputSchema.safeParse(idx(MEMORY_INDEX_MAX_LINES + 1)).success).toBe(false);
    // a topic file may exceed the index line limit
    expect(
      rememberInputSchema.safeParse({ scope: "user", path: "t.md", content: lines(500) }).success,
    ).toBe(true);
  });
  it("recall takes path with scope, or a query, not both", () => {
    expect(recallInputSchema.safeParse({ scope: "user", path: "a.md" }).success).toBe(true);
    expect(recallInputSchema.safeParse({ query: "deploy" }).success).toBe(true);
    expect(recallInputSchema.safeParse({ scope: "project", query: "deploy" }).success).toBe(true);
    expect(recallInputSchema.safeParse({}).success).toBe(true);
    expect(recallInputSchema.safeParse({ path: "a.md" }).success).toBe(false);
    expect(recallInputSchema.safeParse({ scope: "user", path: "a.md", query: "q" }).success).toBe(
      false,
    );
    expect(recallInputSchema.safeParse({ query: "" }).success).toBe(false);
  });
  it("maps tool names to schemas", () => {
    expect(Object.keys(memoryToolInputSchema)).toEqual(["remember", "recall"]);
  });
});

describe("kobe-tools ops", () => {
  it("memory.put and memory.read requests", () => {
    const put = {
      id: "r1",
      op: "memory.put",
      tool_call_id: "tc",
      input: { scope: "user", path: "a.md", content: "x" },
    };
    expect(memoryToolsRequestSchema.safeParse(put).success).toBe(true);
    expect(
      memoryToolsRequestSchema.safeParse({ ...put, input: { scope: "user", path: "a.md" } })
        .success,
    ).toBe(false);
    const read = { id: "r2", op: "memory.read", input: { query: "q" } };
    expect(memoryToolsRequestSchema.safeParse(read).success).toBe(true);
  });
  it("responses: applied, pending approval, read, error", () => {
    const base = { id: "r1", ok: true };
    expect(
      memoryToolsResponseSchema.safeParse({
        ...base,
        op: "put",
        status: "applied",
        scope: "user",
        path: "a.md",
        version: 2,
        previous_version: 1,
      }).success,
    ).toBe(true);
    expect(
      memoryToolsResponseSchema.safeParse({
        ...base,
        op: "put",
        status: "pending_approval",
        scope: "project",
        path: "a.md",
      }).success,
    ).toBe(true);
    expect(
      memoryToolsResponseSchema.safeParse({
        ...base,
        op: "read",
        files: [{ scope: "user", path: "a.md", content: "x", version: 1 }],
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      memoryToolsResponseSchema.safeParse({
        id: "r1",
        ok: false,
        error: { code: "memory_disabled", message: "off" },
      }).success,
    ).toBe(true);
    expect(
      memoryToolsResponseSchema.safeParse({
        id: "r1",
        ok: false,
        error: { code: "Bad", message: "x" },
      }).success,
    ).toBe(false);
  });
});

describe("wire frames", () => {
  const v = SANDBOX_WIRE_VERSION;
  it("memory.put / memory.read from the sandbox, memory.result back", () => {
    const put = {
      v,
      type: "memory.put",
      request_id: "q1",
      run_id: ID,
      thread_id: ID2,
      tool_call_id: "tc",
      input: { scope: "user", path: "a.md", content: "x" },
    };
    expect(decodeSandboxFrame(JSON.stringify(put)).ok).toBe(true);
    const read = {
      v,
      type: "memory.read",
      request_id: "q2",
      run_id: ID,
      thread_id: ID2,
      input: { path: "a.md", scope: "user" },
    };
    expect(decodeSandboxFrame(JSON.stringify(read)).ok).toBe(true);
    const result = {
      v,
      type: "memory.result",
      request_id: "q1",
      ok: true,
      op: "put",
      status: "applied",
      scope: "user",
      path: "a.md",
      version: 1,
    };
    expect(decodeServerFrame(JSON.stringify(result)).ok).toBe(true);
    const fail = {
      v,
      type: "memory.result",
      request_id: "q1",
      ok: false,
      error: { code: "future_code", message: "m" },
    };
    expect(decodeServerFrame(JSON.stringify(fail)).ok).toBe(true);
  });
  it("memory.put with a mismatching input is rejected", () => {
    const bad = {
      v,
      type: "memory.put",
      request_id: "q1",
      run_id: ID,
      thread_id: ID2,
      tool_call_id: "tc",
      input: { scope: "user" },
    };
    expect(decodeSandboxFrame(JSON.stringify(bad)).ok).toBe(false);
  });
});

describe("run.start memory context", () => {
  const base = {
    v: SANDBOX_WIRE_VERSION,
    type: "run.start",
    command_id: "c",
    run_id: ID,
    thread_id: ID2,
    message: "hi",
  };
  it("old run.start without memory still decodes", () => {
    expect(runStartFrameSchema.safeParse(base).success).toBe(true);
  });
  it("carries indexes and enabled scopes", () => {
    const memory = {
      scopes: ["user", "project"],
      indexes: [
        { scope: "user", content: "- [style](style.md)", version: 3, truncated: false },
        { scope: "project", content: "", version: 0, truncated: false },
      ],
    };
    expect(runMemoryContextSchema.safeParse(memory).success).toBe(true);
    expect(runStartFrameSchema.safeParse({ ...base, memory }).success).toBe(true);
    expect(runMemoryContextSchema.safeParse({ scopes: [], indexes: [] }).success).toBe(true);
    expect(
      runMemoryContextSchema.safeParse({
        scopes: ["user"],
        indexes: [{ scope: "team", content: "", version: 1, truncated: false }],
      }).success,
    ).toBe(false);
  });
});

describe("memory.updated and Undo", () => {
  const payload = EVENT_PAYLOAD_SCHEMAS["memory.updated"];
  const old = { scope: "user", memory_doc_id: ID, path: "a.md", version: 2, previous_version: 1 };
  it("old payloads still decode; new optional fields decode", () => {
    expect(payload.safeParse(old).success).toBe(true);
    expect(payload.safeParse({ ...old, tool_call_id: "tc", mode: "append" }).success).toBe(true);
  });
  it("derives the Undo action", () => {
    expect(undoMemoryAction(old as never)).toEqual({ action: "restore", version: 1 });
    expect(undoMemoryAction({ ...old, version: 1, previous_version: undefined } as never)).toEqual({
      action: "delete",
    });
  });
});

describe("panel API", () => {
  const doc = {
    id: ID,
    scope: "user",
    path: "a.md",
    current_version: 2,
    size_bytes: 10,
    updated_at: TS,
    updated_by: ID2,
  };
  it("list, detail, settings", () => {
    expect(memoryListResponseSchema.safeParse({ docs: [doc] }).success).toBe(true);
    expect(
      memoryDocDetailSchema.safeParse({
        ...doc,
        content: "x",
        versions: [{ version: 1, size_bytes: 1, created_at: TS, source: "agent" }],
      }).success,
    ).toBe(true);
    expect(
      memorySettingsSchema.safeParse({ memory_enabled: true, project_memory_enabled: false })
        .success,
    ).toBe(true);
    expect(memorySettingsSchema.safeParse({ memory_enabled: "yes" }).success).toBe(false);
  });
});
