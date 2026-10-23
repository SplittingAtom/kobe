import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOLS,
  OPEN_FILE_TOOL,
  fileOpenFrameSchema,
  fileOpenResultFrameSchema,
  kobeEventSchema,
  kobeToolsRequestSchema,
  kobeToolsResponseSchema,
  openFileInputSchema,
  sandboxToServerFrameSchema,
  serverToSandboxFrameSchema,
} from "./index.js";

const RUN = "3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const THREAD = "4a3b2c1d-6e5f-4a7b-9c8d-1e2f3a4b5c6d";

describe("open_file contract (KOBE-484)", () => {
  it("is a built-in read on Kobe's side, checked by path", () => {
    expect(OPEN_FILE_TOOL).toBe("open_file");
    expect(BUILTIN_TOOLS.open_file).toEqual({
      source: "kobe",
      risk: "read",
      scope: "kobe",
      open_world: false,
      primary_arg: "/path",
    });
  });

  it("takes a path only; no traversal, no control characters", () => {
    expect(openFileInputSchema.safeParse({ path: "/workspace/notes.md" }).success).toBe(true);
    expect(openFileInputSchema.safeParse({ path: "notes.md" }).success).toBe(true);
    for (const bad of [
      {},
      { path: "" },
      { path: "../etc/passwd" },
      { path: "a\nb" },
      { path: "notes.md", content: "x" },
    ]) {
      expect(openFileInputSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("frames the call both ways and answers with the opened path", () => {
    const frame = {
      v: 1,
      type: "file.open",
      request_id: "fo_1",
      run_id: RUN,
      thread_id: THREAD,
      tool_call_id: "call_1",
      tool: "open_file",
      input: { path: "notes.md" },
    };
    expect(fileOpenFrameSchema.safeParse(frame).success).toBe(true);
    expect(sandboxToServerFrameSchema.safeParse(frame).success).toBe(true);
    const ok = { v: 1, type: "file.open_result", request_id: "fo_1", ok: true, op: "file_open" };
    expect(fileOpenResultFrameSchema.safeParse({ ...ok, path: "notes.md" }).success).toBe(true);
    expect(serverToSandboxFrameSchema.safeParse({ ...ok, path: "notes.md" }).success).toBe(true);
    const fail = {
      v: 1,
      type: "file.open_result",
      request_id: "fo_1",
      ok: false,
      error: { code: "not_found", message: "No such file." },
    };
    expect(fileOpenResultFrameSchema.safeParse(fail).success).toBe(true);
    expect(
      kobeToolsRequestSchema.safeParse({
        id: "k1",
        op: "file.open",
        tool_call_id: "call_1",
        tool: "open_file",
        input: { path: "notes.md" },
      }).success,
    ).toBe(true);
    expect(
      kobeToolsResponseSchema.safeParse({ id: "k1", ok: true, op: "file_open", path: "a.md" })
        .success,
    ).toBe(true);
  });

  it("records file.opened with the path only, never content", () => {
    const event = {
      run_id: RUN,
      seq: 3,
      ts: "2026-10-22T10:00:00.000Z",
      type: "file.opened",
      payload: { tool_call_id: "call_1", path: "notes.md" },
    };
    expect(kobeEventSchema.safeParse(event).success).toBe(true);
    expect(
      kobeEventSchema.safeParse({ ...event, payload: { ...event.payload, content: "x" } }).success,
    ).toBe(false);
  });
});
