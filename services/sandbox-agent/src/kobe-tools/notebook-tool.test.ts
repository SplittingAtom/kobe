import { describe, expect, it } from "vitest";
import {
  CAPABILITY_NOTEBOOKS,
  NOTEBOOK_CODE_MAX_BYTES,
  NOTEBOOK_TIMEOUT_DEFAULT_S,
  NOTEBOOK_TIMEOUT_MAX_S,
  RUN_PYTHON_TOOL,
  kobeToolsResponseSchema,
  runPythonInputSchema,
} from "@kobe/protocol";
import type { ToolsOutcome } from "./client.js";
import { notebooksEnabled, registerKobeTools } from "./extension.js";
import { parseNotebookReply, runPythonTool } from "./notebook-tool.js";
import * as P from "./protocol.js";
import type { ToolsTransport } from "./tools.js";

const RAN = {
  ok: true,
  op: "notebook_run",
  status: "ok",
  execution_count: 3,
  text: "2",
  truncated: false,
  saved: { path: "a.ipynb", sha256: "d".repeat(64) },
} as const satisfies ToolsOutcome;

function transport(outcome: ToolsOutcome) {
  const calls: { call: unknown; options: unknown }[] = [];
  const t: ToolsTransport = {
    request: (call, options) => {
      calls.push({ call, options });
      return Promise.resolve(outcome);
    },
  };
  return { t, calls };
}

describe("run_python (KOBE-464)", () => {
  it("mirrors the protocol", () => {
    expect(P.OP_NOTEBOOK_RUN).toBe("notebook.run");
    expect(P.OPS).toContain("notebook.run");
    expect(P.TOOL_RUN_PYTHON).toBe(RUN_PYTHON_TOOL);
    expect(P.NOTEBOOK_CODE_MAX_BYTES).toBe(NOTEBOOK_CODE_MAX_BYTES);
    expect(P.NOTEBOOK_TIMEOUT_DEFAULT_S).toBe(NOTEBOOK_TIMEOUT_DEFAULT_S);
    expect(P.NOTEBOOK_TIMEOUT_MAX_S).toBe(NOTEBOOK_TIMEOUT_MAX_S);
    expect(CAPABILITY_NOTEBOOKS).toBe("notebooks");
    expect(kobeToolsResponseSchema.safeParse({ id: "kt_1", ...RAN }).success).toBe(true);
  });

  it("sends notebook.run with a deadline past the cell's own, and summarizes", async () => {
    const { t, calls } = transport(RAN);
    const input = { path: "/workspace/a.ipynb", cell_id: "c1", timeout_s: 30 };
    expect(runPythonInputSchema.safeParse(input).success).toBe(true);
    const result = await runPythonTool(t).execute("call_1", input);
    expect(calls).toEqual([
      {
        call: { op: "notebook.run", tool_call_id: "call_1", tool: "run_python", input },
        options: { timeoutMs: 30_000 + P.NOTEBOOK_ANSWER_MARGIN_MS },
      },
    ]);
    expect(result.content[0]?.text).toBe(
      "status: ok\nexecution_count: 3\noutputs saved to a.ipynb\n\n2",
    );
  });

  it("refuses input the server would refuse, before sending anything", async () => {
    const { t, calls } = transport(RAN);
    for (const bad of [
      {},
      { code: "1", path: "a.py" },
      { path: "a.ipynb" },
      { path: "a.py", cell_id: "c" },
      { code: "1", cell_id: "c" },
      { path: "../x.py" },
      { path: "x.sh" },
      { code: "x", timeout_s: 0 },
      { code: "x", timeout_s: NOTEBOOK_TIMEOUT_MAX_S + 1 },
      { code: "x".repeat(NOTEBOOK_CODE_MAX_BYTES + 1) },
      { code: "1", other: 1 },
    ]) {
      await expect(runPythonTool(t).execute("c", bad)).rejects.toThrow(/invalid input/);
      expect(runPythonInputSchema.safeParse(bad).success).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("turns a server refusal into a tool error", async () => {
    const { t } = transport({ ok: false, error: { code: "cell_not_found", message: "no cell" } });
    await expect(runPythonTool(t).execute("c", { code: "1" })).rejects.toThrow(
      "cell_not_found: no cell",
    );
  });

  it("parses replies strictly", () => {
    expect(parseNotebookReply({ id: "k", ...RAN })).toEqual({ id: "k", ...RAN });
    expect(parseNotebookReply({ id: "k", ...RAN, status: "maybe" })).toBeUndefined();
    expect(
      parseNotebookReply({ id: "k", ...RAN, saved: { path: "a", sha256: "x" } }),
    ).toBeUndefined();
    expect(parseNotebookReply({ id: "k", ...RAN, execution_count: -1 })).toBeUndefined();
  });

  it("is registered only with the notebooks flag", () => {
    const env: Record<string, string | undefined> = { [P.TOOLS_NOTEBOOKS_ENV]: "1" };
    expect(notebooksEnabled(env)).toBe(true);
    expect(env[P.TOOLS_NOTEBOOKS_ENV]).toBeUndefined();
    const names = (notebooks: boolean) => {
      const tools: string[] = [];
      registerKobeTools({ registerTool: (tool) => tools.push(tool.name) }, transport(RAN).t, {
        notebooks,
      });
      return tools;
    };
    expect(names(true)).toContain("run_python");
    expect(names(false)).not.toContain("run_python");
  });
});
