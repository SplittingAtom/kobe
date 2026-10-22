import { randomUUID } from "node:crypto";
import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import {
  NOTEBOOK_CODE_MAX_BYTES,
  NOTEBOOK_TIMEOUT_DEFAULT_S,
  isActiveRunStatus,
  notebookKernelResultSchema,
  type ActorContext,
  type NotebookError,
  type NotebookKernelResponse,
  type NotebookRunBody,
  type NotebookRunResponse,
} from "@kobe/protocol";
import type { Logger } from "pino";
import { appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import { lockOwnedThread } from "../runs/access.js";
import { failureInfo } from "../runs/failure-codes.js";
import { threadRunRows } from "../runs/store.js";
import { NOTEBOOK_COMMAND_MARGIN_MS } from "../sandbox-wire/constants.js";
import { endRunInTx } from "../sandbox-wire/run-state.js";
import type { CommandOutcome, SandboxRouter } from "../sandbox-wire/types.js";
import type { Viewer } from "../threads/repository.js";
import {
  finishExecution,
  resolveSource,
  sourceProblemMessage,
  startedPayload,
  type Execution,
  type SourceProblem,
} from "./execution.js";
import type { NotebookFiles } from "./files.js";

/**
 * The member runs a cell or a `.py` file (docs/specs/notebooks.md NB6, NB7): a run of kind
 * `notebook` on their idle thread, answered at once with its ids; the requesting replica sends
 * `notebook.execute` (waking the sandbox), saves the outputs and ends the run in the background.
 */
export class NotebookRunError extends Error {
  constructor(
    readonly code: NotebookError["code"],
    message: string,
  ) {
    super(message);
    this.name = "NotebookRunError";
  }
}

export const NOTEBOOK_ERROR_STATUS: Readonly<Record<NotebookError["code"], number>> = {
  invalid_request: 400,
  thread_not_found: 404,
  not_found: 404,
  not_a_notebook: 422,
  cell_not_found: 404,
  not_code_cell: 422,
  too_large: 413,
  thread_busy: 409,
  sandbox_unavailable: 503,
  notebooks_unsupported: 409,
  isolation_unavailable: 503,
  sandbox_refused: 409,
};

/** What the orchestrator lends a notebook run. */
export interface NotebookRunHost {
  readonly db: KobeDb;
  readonly router: SandboxRouter;
  readonly files: NotebookFiles | undefined;
  readonly log: Logger;
  /** Refuse while the isolation runtime is missing (D4). */
  readonly isolationMissing: () => boolean;
  /** A team transaction as `actor` with the thread lock timeout (busy → `thread_busy`). */
  threadTx<T>(actor: ActorContext, fn: (tx: KobeTx, viewer: Viewer) => Promise<T>): Promise<T>;
  /** Account active and still a member (no budget: a notebook run calls no model). */
  assertMayRun(tx: KobeTx, actor: ActorContext): Promise<void>;
  /** The run ended: advance the thread's queue. */
  ended(teamId: string, runId: string, threadId: string): Promise<void>;
  /** Background work the orchestrator waits for on shutdown (and tests on `idle`). */
  track(task: Promise<unknown>): void;
}

const PROBLEM_CODE: Readonly<Record<SourceProblem, NotebookError["code"]>> = {
  not_found: "not_found",
  too_large: "too_large",
  not_a_notebook: "not_a_notebook",
  cell_not_found: "cell_not_found",
  not_code_cell: "not_code_cell",
  unavailable: "sandbox_unavailable",
};

export async function startNotebookRun(
  host: NotebookRunHost,
  actor: ActorContext,
  threadId: string,
  body: NotebookRunBody,
): Promise<NotebookRunResponse> {
  if (host.isolationMissing()) {
    throw new NotebookRunError("isolation_unavailable", "Sandboxes are unavailable right now.");
  }
  const files = host.files;
  if (files === undefined) {
    throw new NotebookRunError("sandbox_unavailable", "Workspace files are not available here.");
  }
  // The owner first (only they run in their sandbox), then their own synced copy is read.
  await host.threadTx(actor, (tx, viewer) =>
    lockOwnedThread(tx, viewer, threadId, "thread_not_found"),
  );
  const owner = { teamId: actor.team_id, userId: actor.user_id };
  const resolved = await resolveSource(
    files,
    owner,
    { path: body.path, cellId: body.cell_id },
    NOTEBOOK_CODE_MAX_BYTES,
  );
  if (!resolved.ok) {
    throw new NotebookRunError(
      PROBLEM_CODE[resolved.problem],
      sourceProblemMessage(resolved.problem),
    );
  }
  const execId = randomUUID();
  const runId = await host.threadTx(actor, async (tx, viewer) => {
    const thread = await lockOwnedThread(tx, viewer, threadId, "thread_not_found");
    await host.assertMayRun(tx, actor);
    const active = (await threadRunRows(tx, actor.team_id, thread.id)).some((r) =>
      isActiveRunStatus(r.status),
    );
    if (active || thread.status !== "idle") {
      throw new NotebookRunError("thread_busy", "The conversation is busy; wait for it to finish.");
    }
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO runs (team_id, thread_id, trigger, kind, status, started_at)
      VALUES (${actor.team_id}, ${thread.id}, 'user', 'notebook', 'running', now())
      RETURNING id`);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error("notebook run insert returned no row");
    await tx.execute(sql`
      UPDATE threads SET status = 'running', last_activity_at = now()
       WHERE team_id = ${actor.team_id} AND id = ${thread.id}`);
    const execution = executionOf(owner, id, execId, resolved.source);
    await appendRunEventsInTx(tx, actor.team_id, id, [
      {
        type: "run.started",
        payload: { thread_id: thread.id, agent_id: null, agent_version: null },
      },
      { type: "notebook.started", payload: startedPayload(execution) },
    ]);
    return id;
  });
  const execution = executionOf(owner, runId, execId, resolved.source);
  const timeoutMs = (body.timeout_s ?? NOTEBOOK_TIMEOUT_DEFAULT_S) * 1000;
  host.track(runInBackground(host, files, execution, threadId, timeoutMs));
  return { run_id: runId, exec_id: execId };
}

function executionOf(
  owner: { readonly teamId: string; readonly userId: string },
  runId: string,
  execId: string,
  source: Execution["source"],
): Execution {
  return { owner, runId, execId, origin: "user", source };
}

async function runInBackground(
  host: NotebookRunHost,
  files: NotebookFiles,
  execution: Execution,
  threadId: string,
  timeoutMs: number,
): Promise<void> {
  const { teamId } = execution.owner;
  const outcome = await host.router
    .notebookExecute(
      execution.owner,
      {
        threadId,
        runId: execution.runId,
        execId: execution.execId,
        code: execution.source.code,
        timeoutMs,
      },
      { timeoutMs: timeoutMs + NOTEBOOK_COMMAND_MARGIN_MS },
    )
    .catch((err: unknown): CommandOutcome => ({
      ok: false,
      error: { code: "internal", message: (err as Error).message },
    }));
  if (!outcome.ok) {
    // The sandbox's text is untrusted: logged (capped), never shown.
    host.log.warn(
      {
        run_id: execution.runId,
        code: outcome.error.code,
        error: outcome.error.message.slice(0, 300),
      },
      "notebook execution failed",
    );
  }
  try {
    await finishExecution({ db: host.db, files, log: host.log }, execution, outcome);
  } catch (err) {
    host.log.error({ err, run_id: execution.runId }, "recording a notebook execution failed");
  }
  const { ended } = await withAppendTx(host.db, teamId, (tx) =>
    endRunInTx(
      tx,
      teamId,
      execution.runId,
      outcome.ok
        ? { status: "completed" }
        : { status: "failed", error: failureInfo(failureCode(outcome), "start_failed") },
    ),
  );
  if (ended) await host.ended(teamId, execution.runId, threadId);
}

/** The member sees the server's own message for these; anything else is `start_failed`. */
function failureCode(outcome: Extract<CommandOutcome, { ok: false }>): string {
  const code = outcome.error.code;
  return code === "timeout" || code === "workspace_unavailable" ? code : "start_failed";
}

/** Interrupt or restart the thread's kernel (NB7); never wakes a sandbox. */
export async function notebookKernel(
  host: NotebookRunHost,
  actor: ActorContext,
  threadId: string,
  op: "interrupt" | "restart",
): Promise<NotebookKernelResponse> {
  await host.threadTx(actor, (tx, viewer) =>
    lockOwnedThread(tx, viewer, threadId, "thread_not_found"),
  );
  const target = { teamId: actor.team_id, userId: actor.user_id };
  if (!(await host.router.isConnected(target, threadId))) return { status: "no_kernel" };
  const outcome = await host.router.notebookKernel(target, { threadId, op });
  if (!outcome.ok) {
    if (outcome.error.code === "notebooks_unsupported") {
      throw new NotebookRunError("notebooks_unsupported", "This workspace runs no notebooks yet.");
    }
    host.log.warn({ code: outcome.error.code }, "notebook kernel command failed");
    throw new NotebookRunError("sandbox_unavailable", "Your workspace did not answer; try again.");
  }
  const parsed = notebookKernelResultSchema.safeParse(outcome.data);
  if (!parsed.success) {
    throw new NotebookRunError("sandbox_unavailable", "Your workspace gave an unexpected answer.");
  }
  return parsed.data;
}
