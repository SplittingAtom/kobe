import {
  NOTEBOOK_ANSWER_MARGIN_MS,
  NOTEBOOK_CODE_MAX_BYTES,
  NOTEBOOK_TIMEOUT_DEFAULT_S,
  NOTEBOOK_TIMEOUT_MAX_S,
  OP_NOTEBOOK_RUN,
  SHARE_PATH_MAX,
  TOOL_RUN_PYTHON,
  type ToolsResponse,
} from "./protocol.js";
import {
  ToolFailure,
  type ToolDefinitionLike,
  type ToolResultLike,
  type ToolsTransport,
} from "./tools.js";

const KEYS = new Set(["code", "path", "cell_id", "timeout_s"]);
const CELL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/u; // eslint-disable-line no-control-regex
const STATUSES = new Set(["ok", "error", "interrupted", "timeout", "restarted", "failed"]);

const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    code: {
      type: "string",
      minLength: 1,
      description: `Python code to run in this conversation's kernel (at most ${NOTEBOOK_CODE_MAX_BYTES} bytes). Give code or path, not both.`,
    },
    path: {
      type: "string",
      minLength: 1,
      maxLength: SHARE_PATH_MAX,
      description:
        "A .py file under /workspace to run whole, or an .ipynb notebook (then cell_id names the code cell to run; its outputs are saved into the notebook).",
    },
    cell_id: {
      type: "string",
      pattern: CELL_ID.source,
      description: "The id of the notebook cell to run (only with an .ipynb path).",
    },
    timeout_s: {
      type: "integer",
      minimum: 1,
      maximum: NOTEBOOK_TIMEOUT_MAX_S,
      description: `Stop the execution after this many seconds (default ${NOTEBOOK_TIMEOUT_DEFAULT_S}).`,
    },
  },
};

/**
 * `run_python` (KOBE-464, docs/specs/notebooks.md NB13): registered only for an agent that announced
 * `notebooks`. Runs code in the thread's live kernel (state carries between calls), through
 * kobe-policy like any tool; the server reads a notebook cell or `.py` file from the synced copy,
 * streams the outputs to the user and saves a cell's outputs into its notebook. The model gets a
 * text summary.
 */
export function runPythonTool(transport: ToolsTransport): ToolDefinitionLike {
  return {
    name: TOOL_RUN_PYTHON,
    label: "Run Python",
    description:
      "Run Python in this conversation's live kernel (variables, imports and data stay loaded between calls, like a notebook). Pass code, a .py file, or an .ipynb path with a cell_id. The user sees the outputs (text, tables, charts); you get them as text.",
    promptSnippet: "Run Python in the conversation's live notebook kernel",
    promptGuidelines: [
      "Use run_python for data analysis and charts: the kernel keeps state between calls, so load data once and reuse it. Plots made with matplotlib are shown to the user.",
      "To run a cell of a notebook the user has open, pass its path and cell_id; the outputs are saved into the notebook. To change a cell's code, propose the edit with propose_file_edit instead of rewriting the notebook.",
      "The kernel has no internet access; install packages with the shell tool if you must (pip install --user), then import them in run_python.",
    ],
    parameters: PARAMETERS,
    execute: (toolCallId, params) => run(transport, toolCallId, params),
  };
}

function validInput(input: Record<string, unknown>): boolean {
  const { code, path, cell_id: cell, timeout_s: timeout } = input;
  if (!Object.keys(input).every((key) => KEYS.has(key))) return false;
  if ((code === undefined) === (path === undefined)) return false;
  if (code !== undefined) {
    if (typeof code !== "string" || code === "" || code.includes("\u0000")) return false;
    if (Buffer.byteLength(code) > NOTEBOOK_CODE_MAX_BYTES || cell !== undefined) return false;
  }
  if (path !== undefined) {
    if (typeof path !== "string" || path === "" || path.length > SHARE_PATH_MAX) return false;
    if (CONTROL.test(path) || path.split("/").includes("..")) return false;
    const notebook = path.endsWith(".ipynb");
    if (!notebook && !path.endsWith(".py")) return false;
    if (notebook !== (cell !== undefined)) return false;
    if (cell !== undefined && (typeof cell !== "string" || !CELL_ID.test(cell))) return false;
  }
  return (
    timeout === undefined ||
    (typeof timeout === "number" &&
      Number.isInteger(timeout) &&
      timeout >= 1 &&
      timeout <= NOTEBOOK_TIMEOUT_MAX_S)
  );
}

async function run(
  transport: ToolsTransport,
  toolCallId: string,
  params: unknown,
): Promise<ToolResultLike> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new ToolFailure("invalid input");
  }
  const input = params as Record<string, unknown>;
  if (!validInput(input)) {
    throw new ToolFailure(
      "invalid input: expected { code } or { path } (.py, or .ipynb with cell_id), optional timeout_s",
    );
  }
  const timeoutS =
    typeof input.timeout_s === "number" ? input.timeout_s : NOTEBOOK_TIMEOUT_DEFAULT_S;
  const outcome = await transport.request(
    { op: OP_NOTEBOOK_RUN, tool_call_id: toolCallId, tool: TOOL_RUN_PYTHON, input },
    { timeoutMs: timeoutS * 1000 + NOTEBOOK_ANSWER_MARGIN_MS },
  );
  if (!outcome.ok) throw new ToolFailure(`${outcome.error.code}: ${outcome.error.message}`);
  if (!("op" in outcome) || outcome.op !== "notebook_run") {
    throw new ToolFailure("unexpected answer to run_python");
  }
  const header = [
    `status: ${outcome.status}`,
    ...(outcome.execution_count === null ? [] : [`execution_count: ${outcome.execution_count}`]),
    ...(outcome.saved === null ? [] : [`outputs saved to ${outcome.saved.path}`]),
    ...(outcome.truncated ? ["(output truncated)"] : []),
  ].join("\n");
  return {
    content: [
      { type: "text", text: outcome.text === "" ? header : `${header}\n\n${outcome.text}` },
    ],
    details: {
      status: outcome.status,
      execution_count: outcome.execution_count,
      truncated: outcome.truncated,
      saved: outcome.saved,
    },
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** A `run_python` answer, or undefined when it is malformed (fail closed). */
export function parseNotebookReply(value: Record<string, unknown>): ToolsResponse | undefined {
  const { status, execution_count: count, text, truncated, saved } = value;
  if (typeof status !== "string" || !STATUSES.has(status)) return undefined;
  if (count !== null && !(typeof count === "number" && Number.isInteger(count) && count >= 0)) {
    return undefined;
  }
  if (typeof text !== "string" || typeof truncated !== "boolean") return undefined;
  let kept: { path: string; sha256: string } | null = null;
  if (saved !== null) {
    if (typeof saved !== "object" || saved === undefined) return undefined;
    const { path, sha256 } = saved as Record<string, unknown>;
    if (typeof path !== "string" || path === "" || typeof sha256 !== "string") return undefined;
    if (!HEX64.test(sha256)) return undefined;
    kept = { path, sha256 };
  }
  return {
    id: value.id as string,
    ok: true,
    op: "notebook_run",
    status,
    execution_count: count,
    text,
    truncated,
    saved: kept,
  };
}
