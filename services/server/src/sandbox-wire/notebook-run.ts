import { randomUUID } from "node:crypto";
import type { KobeDb } from "@kobe/db";
import {
  NOTEBOOK_CODE_MAX_BYTES,
  NOTEBOOK_TIMEOUT_DEFAULT_S,
  workspaceToolPath,
  type NotebookExecuteFrame,
  type NotebookRunFrame,
  type ServerToSandboxFrame,
} from "@kobe/protocol";
import type { Logger } from "pino";
import type { AllowedVerdict } from "../artifacts/allowed.js";
import {
  finishExecution,
  recordStarted,
  resolveSource,
  sourceProblemMessage,
  type Execution,
} from "../notebooks/execution.js";
import type { NotebookFiles } from "../notebooks/files.js";
import { toolText } from "../notebooks/summary.js";
import { NOTEBOOK_COMMAND_MARGIN_MS } from "./constants.js";
import type { CommandOutcome, SandboxTarget } from "./types.js";

/**
 * `notebook.run` (KOBE-464, `run_python`; docs/specs/notebooks.md NB3, NB13) on one connection:
 * served only if it announced `notebooks`, the run is leased here and active, and this call was
 * allowed here with the same canonical input, taken once. The code (as given, or read from the
 * run owner's synced copy) runs in the thread's kernel through a `notebook.execute` on this same
 * connection; the outputs become the run's events, a notebook cell's are saved into the notebook,
 * and the model gets a text summary.
 */
export interface NotebookRunConnection {
  readonly db: KobeDb;
  readonly target: SandboxTarget;
  readonly files: NotebookFiles | undefined;
  readonly log: Pick<Logger, "error" | "warn">;
  readonly hasCapability: boolean;
  readonly runCheck: () => "ok" | "ended" | "violation";
  readonly verdict: () => AllowedVerdict | "replayed";
  /** Sends the `notebook.execute` on this connection and resolves with its answer. */
  readonly execute: (frame: NotebookExecuteFrame, timeoutMs: number) => Promise<CommandOutcome>;
  send(frame: ServerToSandboxFrame): boolean;
}

type Answer =
  | { readonly ok: false; readonly code: string; readonly message: string }
  | Extract<ServerToSandboxFrame, { type: "notebook.run_result"; ok: true }>;

const refused = (code: string, message: string): Answer => ({ ok: false, code, message });

export function onNotebookRun(c: NotebookRunConnection, frame: NotebookRunFrame): void {
  const answer = (out: Answer) =>
    c.send(
      out.ok
        ? out
        : {
            v: 1,
            type: "notebook.run_result",
            request_id: frame.request_id,
            ok: false,
            error: { code: out.code, message: out.message },
          },
    );
  if (!c.hasCapability || c.files === undefined) {
    answer(refused("not_allowed", "This sandbox did not announce notebooks."));
    return;
  }
  const check = c.runCheck();
  if (check === "violation") return;
  if (check === "ended") {
    answer(refused("not_allowed", "The run has ended, so the code was not run."));
    return;
  }
  const verdict = c.verdict();
  if (verdict !== "ok") {
    c.log.warn({ run_id: frame.run_id, verdict, security: true }, "notebook.run refused");
    answer(
      refused(
        "not_allowed",
        verdict === "input_mismatch"
          ? "The code differs from the call that was allowed."
          : verdict === "replayed"
            ? "This tool call was already used to run code."
            : "This tool call was not allowed for this tool.",
      ),
    );
    return;
  }
  void runForAgent(c, c.files, frame)
    .catch((err: unknown): Answer => {
      c.log.error({ err, run_id: frame.run_id }, "notebook.run failed");
      return refused("storage_failed", "The code could not be run. Try again.");
    })
    .then(answer);
}

async function runForAgent(
  c: NotebookRunConnection,
  files: NotebookFiles,
  frame: NotebookRunFrame,
): Promise<Answer> {
  const input = frame.input;
  const path = input.path === undefined ? undefined : workspaceToolPath(input.path);
  if (input.path !== undefined && path === undefined) {
    return refused("invalid_path", "Name a file under /workspace.");
  }
  const owner = { teamId: c.target.teamId, userId: c.target.userId };
  const resolved = await resolveSource(
    files,
    owner,
    { code: input.code, path, cellId: input.cell_id },
    NOTEBOOK_CODE_MAX_BYTES,
  );
  if (!resolved.ok) {
    const code = resolved.problem === "unavailable" ? "storage_failed" : resolved.problem;
    return refused(code, sourceProblemMessage(resolved.problem));
  }
  const execution: Execution = {
    owner,
    runId: frame.run_id,
    execId: randomUUID(),
    origin: "agent",
    toolCallId: frame.tool_call_id,
    source: resolved.source,
  };
  await recordStarted(c.db, execution);
  const timeoutMs = (input.timeout_s ?? NOTEBOOK_TIMEOUT_DEFAULT_S) * 1000;
  const outcome = await c.execute(
    {
      v: 1,
      type: "notebook.execute",
      command_id: randomUUID(),
      thread_id: frame.thread_id,
      run_id: frame.run_id,
      exec_id: execution.execId,
      code: resolved.source.code,
      timeout_ms: timeoutMs,
    },
    timeoutMs + NOTEBOOK_COMMAND_MARGIN_MS,
  );
  const summary = await finishExecution({ db: c.db, files, log: c.log }, execution, outcome);
  if (!outcome.ok) {
    c.log.warn(
      {
        run_id: frame.run_id,
        code: outcome.error.code,
        error: outcome.error.message.slice(0, 300),
      },
      "the sandbox did not run the code",
    );
    return refused(
      "kernel_unavailable",
      "The Python kernel is not available right now (all kernels busy, or it could not start). Try again.",
    );
  }
  return {
    v: 1,
    type: "notebook.run_result",
    request_id: frame.request_id,
    ok: true,
    op: "notebook_run",
    status: summary.status,
    execution_count: summary.executionCount,
    text: toolText(summary.outputs),
    truncated: summary.truncated,
    saved: summary.saved,
  };
}
