import { sql, withTeam, type KobeDb } from "@kobe/db";
import {
  notebookExecuteResultSchema,
  notebookOutputPayloadSchema,
  type NotebookExecStatus,
  type NotebookFinishedPayload,
  type NotebookOutput,
  type NotebookStartedPayload,
} from "@kobe/protocol";
import type { Logger } from "pino";
import { AppendError, appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import type { CommandOutcome } from "../sandbox-wire/types.js";
import { isReadOnlyPath } from "../workspace-files/paths.js";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import type { NotebookFiles } from "./files.js";
import {
  cellSource,
  parseNotebook,
  serializeNotebook,
  withOutputs,
  type Notebook,
} from "./ipynb.js";

/**
 * One kernel execution as the server runs it (docs/specs/notebooks.md NB6, NB11, NB13, NB15), the
 * same for the member's `notebook` run and the agent's `run_python`: resolve the code (a cell of
 * the synced notebook, a synced `.py` file, or code as given), record `notebook.started`, let the
 * sandbox run it, then read the outputs back from the run's events, save them into the notebook
 * at the version the code was read from, and record `notebook.finished`.
 */
export interface SourceRequest {
  readonly code?: string | undefined;
  /** Relative to `/workspace`. */
  readonly path?: string | undefined;
  readonly cellId?: string | undefined;
}

export interface ResolvedSource {
  readonly code: string;
  readonly path?: string;
  readonly cellId?: string;
  /** The notebook the cell was read from, and its version (the save's base). */
  readonly notebook?: { readonly parsed: Notebook; readonly sha256: string };
}

export type SourceProblem =
  "not_found" | "too_large" | "not_a_notebook" | "cell_not_found" | "not_code_cell" | "unavailable";

const PROBLEM_MESSAGES: Readonly<Record<SourceProblem, string>> = {
  not_found: "That file is not in the synced workspace.",
  too_large: "That file is too large to run.",
  not_a_notebook: "That file is not a Jupyter notebook (nbformat 4).",
  cell_not_found: "The notebook has no cell with that id.",
  not_code_cell: "That cell is not a code cell.",
  unavailable: "Workspace files are not available here.",
};

export const sourceProblemMessage = (problem: SourceProblem): string => PROBLEM_MESSAGES[problem];

export async function resolveSource(
  files: NotebookFiles,
  owner: WorkspaceOwner,
  request: SourceRequest,
  maxCodeBytes: number,
): Promise<
  | { readonly ok: true; readonly source: ResolvedSource }
  | { readonly ok: false; readonly problem: SourceProblem }
> {
  if (request.code !== undefined) return { ok: true, source: { code: request.code } };
  const path = request.path;
  if (path === undefined) return { ok: false, problem: "not_found" };
  const read = await files.read(owner, path);
  if (!read.ok) return { ok: false, problem: read.code };
  if (request.cellId === undefined) {
    if (Buffer.byteLength(read.text) > maxCodeBytes) return { ok: false, problem: "too_large" };
    return read.text.trim() === ""
      ? { ok: false, problem: "not_code_cell" }
      : { ok: true, source: { code: read.text, path } };
  }
  const parsed = parseNotebook(read.text);
  if (parsed === undefined) return { ok: false, problem: "not_a_notebook" };
  const cell = cellSource(parsed, request.cellId);
  if (!cell.ok) return { ok: false, problem: cell.problem };
  if (Buffer.byteLength(cell.source) > maxCodeBytes) return { ok: false, problem: "too_large" };
  if (cell.source.trim() === "") return { ok: false, problem: "not_code_cell" };
  return {
    ok: true,
    source: {
      code: cell.source,
      path,
      cellId: request.cellId,
      notebook: { parsed, sha256: read.sha256 },
    },
  };
}

export interface Execution {
  readonly owner: WorkspaceOwner;
  readonly runId: string;
  readonly execId: string;
  readonly origin: "user" | "agent";
  readonly toolCallId?: string;
  readonly source: ResolvedSource;
}

export interface ExecutionDeps {
  readonly db: KobeDb;
  readonly files: NotebookFiles;
  readonly log: Pick<Logger, "warn" | "error">;
}

/** What an execution came to. */
export interface ExecutionSummary {
  readonly status: NotebookExecStatus;
  readonly executionCount: number | null;
  readonly outputs: readonly NotebookOutput[];
  readonly truncated: boolean;
  readonly saved: NotebookFinishedPayload["saved"];
  readonly saveError?: string;
}

/** Records `notebook.started` on the run (inside the caller's transaction, when it has one). */
export function startedPayload(e: Execution): NotebookStartedPayload {
  return {
    exec_id: e.execId,
    origin: e.origin,
    ...(e.toolCallId === undefined ? {} : { tool_call_id: e.toolCallId }),
    ...(e.source.path === undefined ? {} : { path: e.source.path }),
    ...(e.source.cellId === undefined ? {} : { cell_id: e.source.cellId }),
  };
}

export async function recordStarted(db: KobeDb, e: Execution): Promise<void> {
  await withAppendTx(db, e.owner.teamId, (tx) =>
    appendRunEventsInTx(tx, e.owner.teamId, e.runId, [
      { type: "notebook.started", payload: startedPayload(e) },
    ]),
  );
}

/** After the sandbox answered (or could not): save the outputs, record `notebook.finished`. */
export async function finishExecution(
  deps: ExecutionDeps,
  e: Execution,
  outcome: CommandOutcome,
): Promise<ExecutionSummary> {
  const result = outcome.ok ? notebookExecuteResultSchema.safeParse(outcome.data) : undefined;
  if (outcome.ok && !result?.success) {
    deps.log.warn({ run_id: e.runId }, "the sandbox sent a malformed notebook result");
  }
  const ran = result?.success === true ? result.data : undefined;
  const outputs = await readOutputs(deps.db, e.owner.teamId, e.runId, e.execId);
  const status: NotebookExecStatus = ran?.status ?? "failed";
  const executionCount = ran?.execution_count ?? null;
  const save =
    ran !== undefined && e.source.notebook !== undefined
      ? await saveOutputs(deps, e, outputs, executionCount)
      : { saved: null };
  const summary: ExecutionSummary = {
    status,
    executionCount,
    outputs,
    truncated: ran?.truncated ?? false,
    ...save,
  };
  const finished: NotebookFinishedPayload = {
    exec_id: e.execId,
    status,
    execution_count: executionCount,
    outputs: outputs.length,
    truncated: summary.truncated,
    saved: summary.saved,
    ...(summary.saveError === undefined ? {} : { save_error: summary.saveError }),
  };
  await withAppendTx(deps.db, e.owner.teamId, (tx) =>
    appendRunEventsInTx(tx, e.owner.teamId, e.runId, [
      { type: "notebook.finished", payload: finished },
    ]),
  ).catch((err: unknown) => {
    // A run that ended meanwhile (Stop) takes no more events; the outputs are saved anyway.
    if (err instanceof AppendError) {
      deps.log.warn({ run_id: e.runId, code: err.code }, "notebook.finished not recorded");
      return;
    }
    throw err;
  });
  return summary;
}

/** The execution's outputs as the server stored them, in order. */
export async function readOutputs(
  db: KobeDb,
  teamId: string,
  runId: string,
  execId: string,
): Promise<NotebookOutput[]> {
  const res = await withTeam(db, teamId, (tx) =>
    tx.execute<{ payload: unknown }>(sql`
      SELECT payload FROM run_events
       WHERE team_id = ${teamId} AND run_id = ${runId} AND type = 'notebook.output'
         AND payload->>'exec_id' = ${execId}
       ORDER BY seq`),
  );
  const outputs: NotebookOutput[] = [];
  for (const row of res.rows) {
    const parsed = notebookOutputPayloadSchema.safeParse(row.payload);
    if (parsed.success) outputs.push(parsed.data.output);
  }
  return outputs;
}

type SaveOutcome = Pick<ExecutionSummary, "saved" | "saveError">;

/**
 * NB11: into the version the code was read from; on a conflict once more into the current version
 * if the cell is still there. Never throws: a failed save is a `save_error`.
 */
async function saveOutputs(
  deps: ExecutionDeps,
  e: Execution,
  outputs: readonly NotebookOutput[],
  executionCount: number | null,
): Promise<SaveOutcome> {
  const { path, cellId, notebook } = e.source;
  if (path === undefined || cellId === undefined || notebook === undefined) return { saved: null };
  if (isReadOnlyPath(path)) return { saved: null, saveError: "read_only" };
  try {
    const first = await saveInto(deps, e.owner, path, cellId, notebook, outputs, executionCount);
    if (first.ok || first.code !== "version_conflict") return outcomeOf(path, first);
    const again = await deps.files.read(e.owner, path);
    if (!again.ok) return { saved: null, saveError: again.code };
    const parsed = parseNotebook(again.text);
    if (parsed === undefined) return { saved: null, saveError: "not_a_notebook" };
    const current = { parsed, sha256: again.sha256 };
    return outcomeOf(
      path,
      await saveInto(deps, e.owner, path, cellId, current, outputs, executionCount),
    );
  } catch (err) {
    deps.log.error({ err, run_id: e.runId }, "saving notebook outputs failed");
    return { saved: null, saveError: "storage_failed" };
  }
}

type SaveTry =
  { readonly ok: true; readonly sha256: string } | { readonly ok: false; readonly code: string };

async function saveInto(
  deps: ExecutionDeps,
  owner: WorkspaceOwner,
  path: string,
  cellId: string,
  notebook: { readonly parsed: Notebook; readonly sha256: string },
  outputs: readonly NotebookOutput[],
  executionCount: number | null,
): Promise<SaveTry> {
  const updated = withOutputs(notebook.parsed, cellId, outputs, executionCount);
  if (updated === undefined) return { ok: false, code: "cell_not_found" };
  const result = await deps.files.save(owner, path, notebook.sha256, serializeNotebook(updated));
  if (result.ok) {
    return result.entry.sha256 === undefined
      ? { ok: false, code: "storage_failed" }
      : { ok: true, sha256: result.entry.sha256 };
  }
  return { ok: false, code: result.code };
}

function outcomeOf(path: string, attempt: SaveTry): SaveOutcome {
  return attempt.ok
    ? { saved: { path, sha256: attempt.sha256 } }
    : { saved: null, saveError: attempt.code };
}
