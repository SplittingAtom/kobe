import { describe, expect, it } from "vitest";
import {
  NOTEBOOK_CODE_MAX_BYTES,
  NOTEBOOK_OUTPUT_MAX_BYTES,
  notebookExecuteResultSchema,
  notebookFinishedPayloadSchema,
  notebookOutputSchema,
  notebookRunBodySchema,
  notebookRunOkFields,
  runPythonInputSchema,
} from "./notebooks.js";
import {
  notebookExecuteFrameSchema,
  notebookOutputFrameSchema,
  notebookRunFrameSchema,
  notebookRunResultFrameSchema,
} from "./sandbox-wire/notebook-frames.js";
import { sandboxToServerFrameSchema, serverToSandboxFrameSchema } from "./sandbox-wire/frames.js";
import { kobeToolsRequestSchema, kobeToolsResponseSchema } from "./artifacts.js";
import { BUILTIN_TOOLS } from "./tools.js";
import { z } from "zod";

const RUN = "4f1c2a3b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const THREAD = "5a2b3c4d-6e7f-4a8b-9c0d-1e2f3a4b5c6d";
const EXEC = "6b3c4d5e-7f8a-4b9c-8d1e-2f3a4b5c6d7e";

describe("notebook outputs (NB4)", () => {
  it("accepts the nbformat output kinds with allow-listed MIME types", () => {
    for (const output of [
      { output_type: "stream", name: "stdout", text: "hi\n" },
      { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["line"] },
      {
        output_type: "execute_result",
        execution_count: 3,
        data: { "text/plain": "   a\n0  1", "text/html": "<table></table>" },
        metadata: {},
      },
      {
        output_type: "display_data",
        data: { "image/png": "iVBORw0KGgo=", "text/plain": "<Figure>" },
        metadata: { "image/png": { width: 640, height: 480 } },
      },
      { output_type: "display_data", data: { "application/json": { a: [1, 2] } }, metadata: {} },
    ]) {
      expect(notebookOutputSchema.safeParse(output).success, JSON.stringify(output)).toBe(true);
    }
  });

  it("refuses other MIME types, empty bundles, bad base64, NUL and oversize outputs", () => {
    const display = (data: Record<string, unknown>) => ({
      output_type: "display_data",
      data,
      metadata: {},
    });
    for (const output of [
      display({ "application/javascript": "alert(1)" }),
      display({ "application/vnd.jupyter.widget-view+json": {} }),
      display({}),
      display({ "image/png": "not base64!" }),
      display({ "text/html": 42 }),
      { output_type: "stream", name: "stdin", text: "x" },
      { output_type: "stream", name: "stdout", text: "a\u0000b" },
      { output_type: "stream", name: "stdout", text: "x".repeat(NOTEBOOK_OUTPUT_MAX_BYTES) },
      { output_type: "clear_output", wait: false },
    ]) {
      expect(
        notebookOutputSchema.safeParse(output).success,
        JSON.stringify(output).slice(0, 80),
      ).toBe(false);
    }
  });
});

describe("member run body (NB6)", () => {
  it("needs a cell id for a notebook and none for a .py file", () => {
    expect(notebookRunBodySchema.safeParse({ path: "a.ipynb", cell_id: "c1" }).success).toBe(true);
    expect(notebookRunBodySchema.safeParse({ path: "src/job.py", timeout_s: 30 }).success).toBe(
      true,
    );
    expect(notebookRunBodySchema.safeParse({ path: "a.ipynb" }).success).toBe(false);
    expect(notebookRunBodySchema.safeParse({ path: "job.py", cell_id: "c1" }).success).toBe(false);
    expect(notebookRunBodySchema.safeParse({ path: "notes.md" }).success).toBe(false);
    expect(notebookRunBodySchema.safeParse({ path: "../a.py" }).success).toBe(false);
    expect(notebookRunBodySchema.safeParse({ path: "a.py", timeout_s: 3601 }).success).toBe(false);
    expect(notebookRunBodySchema.safeParse({ path: "a.ipynb", cell_id: "c 1" }).success).toBe(
      false,
    );
  });
});

describe("run_python input (NB13)", () => {
  it("takes code, a .py path, or an .ipynb path with a cell id", () => {
    expect(runPythonInputSchema.safeParse({ code: "1+1" }).success).toBe(true);
    expect(runPythonInputSchema.safeParse({ path: "/workspace/job.py" }).success).toBe(true);
    expect(runPythonInputSchema.safeParse({ path: "a.ipynb", cell_id: "x" }).success).toBe(true);
  });

  it("refuses both or neither, a misplaced cell id, traversal and oversize code", () => {
    for (const input of [
      {},
      { code: "1", path: "a.py" },
      { path: "a.ipynb" },
      { path: "a.py", cell_id: "x" },
      { code: "1", cell_id: "x" },
      { path: "../a.py" },
      { path: "a.sh" },
      { code: "" },
      { code: "x".repeat(NOTEBOOK_CODE_MAX_BYTES + 1) },
      { code: "1", extra: true },
    ]) {
      expect(
        runPythonInputSchema.safeParse(input).success,
        JSON.stringify(input).slice(0, 60),
      ).toBe(false);
    }
  });

  it("is a built-in treated like bash (NB3)", () => {
    expect(BUILTIN_TOOLS.run_python).toEqual({
      source: "kobe",
      risk: "destructive",
      scope: "sandbox",
      open_world: false,
      primary_arg: "/code",
    });
  });

  it("travels on the kobe-tools channel", () => {
    expect(
      kobeToolsRequestSchema.safeParse({
        id: "kt_1",
        op: "notebook.run",
        tool_call_id: "call_1",
        tool: "run_python",
        input: { code: "1+1" },
      }).success,
    ).toBe(true);
    const ok = {
      id: "kt_1",
      ok: true,
      op: "notebook_run",
      status: "ok",
      execution_count: 1,
      text: "2",
      truncated: false,
      saved: null,
    };
    expect(kobeToolsResponseSchema.safeParse(ok).success).toBe(true);
    expect(z.strictObject(notebookRunOkFields).safeParse({ ...ok, id: undefined }).success).toBe(
      false,
    );
  });
});

describe("notebook wire frames", () => {
  const output = { output_type: "stream", name: "stdout", text: "2\n" };

  it("decodes the commands and the agent's frames in the wire unions", () => {
    const execute = {
      v: 1,
      type: "notebook.execute",
      command_id: "c1",
      thread_id: THREAD,
      run_id: RUN,
      exec_id: EXEC,
      code: "1+1",
      timeout_ms: 60_000,
    };
    expect(notebookExecuteFrameSchema.safeParse(execute).success).toBe(true);
    expect(serverToSandboxFrameSchema.safeParse(execute).success).toBe(true);
    for (const type of ["notebook.interrupt", "notebook.restart"]) {
      expect(
        serverToSandboxFrameSchema.safeParse({ v: 1, type, command_id: "c2", thread_id: THREAD })
          .success,
      ).toBe(true);
    }
    const out = {
      v: 1,
      type: "notebook.output",
      command_id: "c1",
      thread_id: THREAD,
      index: 0,
      output,
    };
    expect(notebookOutputFrameSchema.safeParse(out).success).toBe(true);
    expect(sandboxToServerFrameSchema.safeParse(out).success).toBe(true);
    expect(sandboxToServerFrameSchema.safeParse({ ...out, index: 200 }).success).toBe(false);
    const run = {
      v: 1,
      type: "notebook.run",
      request_id: "nb_1",
      run_id: RUN,
      thread_id: THREAD,
      tool_call_id: "call_1",
      tool: "run_python",
      input: { path: "a.ipynb", cell_id: "c1" },
    };
    expect(notebookRunFrameSchema.safeParse(run).success).toBe(true);
    expect(sandboxToServerFrameSchema.safeParse(run).success).toBe(true);
    const result = {
      v: 1,
      type: "notebook.run_result",
      request_id: "nb_1",
      ok: false,
      error: { code: "some_new_code", message: "m" },
    };
    expect(notebookRunResultFrameSchema.safeParse(result).success).toBe(true);
    expect(serverToSandboxFrameSchema.safeParse(result).success).toBe(true);
  });

  it("bounds a command's timeout and code", () => {
    const base = {
      v: 1,
      type: "notebook.execute",
      command_id: "c1",
      thread_id: THREAD,
      run_id: RUN,
      exec_id: EXEC,
      code: "1",
      timeout_ms: 1000,
    };
    expect(notebookExecuteFrameSchema.safeParse({ ...base, timeout_ms: 999 }).success).toBe(false);
    expect(notebookExecuteFrameSchema.safeParse({ ...base, timeout_ms: 3_600_001 }).success).toBe(
      false,
    );
    expect(notebookExecuteFrameSchema.safeParse({ ...base, code: "" }).success).toBe(false);
  });
});

describe("results and the finished event", () => {
  it("a sandbox never reports failed: that is the server's", () => {
    const r = { status: "ok", execution_count: 1, outputs: 1, truncated: false };
    expect(notebookExecuteResultSchema.safeParse(r).success).toBe(true);
    expect(notebookExecuteResultSchema.safeParse({ ...r, status: "failed" }).success).toBe(false);
  });

  it("names a save error only by code", () => {
    const f = {
      exec_id: EXEC,
      status: "error",
      execution_count: null,
      outputs: 0,
      truncated: false,
      saved: null,
      save_error: "version_conflict",
    };
    expect(notebookFinishedPayloadSchema.safeParse(f).success).toBe(true);
    expect(notebookFinishedPayloadSchema.safeParse({ ...f, save_error: "Bad Thing" }).success).toBe(
      false,
    );
  });
});
