import type { RunErrorCode } from "@kobe/protocol";

/**
 * Errors the orchestrator rejects with: the contract's `RUN_ERROR_CODES` plus the server's own
 * (thread state and sandbox reachability). Routes map each code to one HTTP status.
 */
export type OrchestratorErrorCode =
  | RunErrorCode
  | "read_only" // 403: a project reader of a shared thread (D23)
  | "entry_not_found" // 404: parent_entry_id is not an entry of the thread
  | "thread_busy" // 409: the thread row is held past the lock timeout
  | "thread_in_trash" // 409: restore the thread first (KOBE-34)
  | "queue_full" // 409: too many queued messages on the thread
  | "attachments_unavailable" // 422: file_ids but this install has no workspace sync (no S3)
  | "file_not_found" // 404: unknown, foreign, other-thread or rejected file_id (KOBE-144)
  | "file_in_use" // 409: the file is attached to another message already
  | "message_too_large" // 413: the files' total is over the per-message limit
  | "quota_exceeded" // 403: the team has no storage left for the files
  | "storage_unavailable" // 503: object storage did not take the files
  | "sandbox_unavailable"; // 503: the workspace did not answer a steer

export const RUN_ERROR_STATUS: Record<OrchestratorErrorCode, number> = {
  run_not_found: 404,
  thread_not_found: 404,
  entry_not_found: 404,
  forbidden: 403,
  read_only: 403,
  invalid_transition: 409,
  thread_busy: 409,
  thread_in_trash: 409,
  queue_full: 409,
  attachments_unavailable: 422,
  file_not_found: 404,
  file_in_use: 409,
  message_too_large: 413,
  quota_exceeded: 403,
  storage_unavailable: 503,
  budget_exhausted: 429,
  isolation_unavailable: 503,
  sandbox_unavailable: 503,
};

const DEFAULT_MESSAGES: Record<OrchestratorErrorCode, string> = {
  run_not_found: "No run with that id.",
  thread_not_found: "No thread with that id.",
  entry_not_found: "That entry is not part of this thread.",
  forbidden: "You can't do that.",
  read_only: "This thread is shared with you read-only.",
  invalid_transition: "The run is not in a state that allows this.",
  thread_busy: "The thread is busy. Try again.",
  thread_in_trash: "The thread is in Trash. Restore it first.",
  queue_full: "Too many messages are waiting on this thread. Wait for some to run first.",
  attachments_unavailable: "Attachments are not available on this install.",
  file_not_found: "No such file. Upload it again.",
  file_in_use: "That file is already attached to another message.",
  message_too_large: "The attached files are too large for one message.",
  quota_exceeded: "Your team has no storage left. Delete files or ask a team admin for more.",
  storage_unavailable: "File storage did not answer. Try again.",
  budget_exhausted: "The budget is used up, so no new runs can start.",
  isolation_unavailable: "Agents are disabled: the sandbox isolation runtime is not available.",
  sandbox_unavailable: "Your workspace did not answer. Try again.",
};

export class RunError extends Error {
  readonly code: OrchestratorErrorCode;

  constructor(code: OrchestratorErrorCode, message: string = DEFAULT_MESSAGES[code]) {
    super(message);
    this.name = "RunError";
    this.code = code;
  }

  get status(): number {
    return RUN_ERROR_STATUS[this.code];
  }
}

export function isRunError(err: unknown): err is RunError {
  return err instanceof RunError;
}
