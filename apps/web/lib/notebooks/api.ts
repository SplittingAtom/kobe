/**
 * The thread's notebook kernel over the shared client (KOBE-464 routes; KOBE-465 web): run a cell
 * or a `.py` file (202 {run_id, exec_id}; follow the run's events), start (KOBE-477), interrupt or
 * restart. The
 * thread's owner only; the server decides everything.
 */
import type { NotebookKernelResponse, NotebookRunBody } from "@kobe/protocol";
import { apiRequest, type ApiResult } from "../api/client";

export interface NotebookRunStarted {
  readonly runId: string;
  readonly execId: string;
}

/** `POST .../notebook/start` (KOBE-477): waking (ask again after `retryAfterMs`), or the kernel. */
export type KernelStart =
  | { readonly status: "waking"; readonly retryAfterMs: number }
  | { readonly status: "idle" | "busy" };

export interface NotebookApi {
  run(threadId: string, body: NotebookRunBody): Promise<ApiResult<NotebookRunStarted>>;
  start(threadId: string): Promise<ApiResult<KernelStart>>;
  kernel(threadId: string, op: "interrupt" | "restart"): Promise<ApiResult<NotebookKernelResponse>>;
}

const enc = encodeURIComponent;

export function createNotebookApi(teamId: string, fetchFn?: typeof fetch): NotebookApi {
  const opts = { teamId, fetchFn, method: "POST" as const };
  return {
    run: (threadId, body) =>
      apiRequest(`/v1/threads/${enc(threadId)}/notebook/run`, { ...opts, json: body }),
    start: (threadId) =>
      apiRequest(`/v1/threads/${enc(threadId)}/notebook/start`, { ...opts, json: {} }),
    kernel: (threadId, op) =>
      apiRequest(`/v1/threads/${enc(threadId)}/notebook/${op}`, { ...opts, json: {} }),
  };
}

/**
 * The document an HTML output's iframe loads: the server's fixed shell with the artifact frame's
 * headers, to which the page posts the HTML (never `srcdoc`).
 */
export function outputFrameUrl(teamId: string): string {
  return `/v1/workspace/output-frame?${new URLSearchParams({ team: teamId }).toString()}`;
}

/** The message the shell accepts (the server's `NOTEBOOK_OUTPUT_FRAME_MESSAGE`). */
export const OUTPUT_FRAME_MESSAGE = "kobe.notebook.html";
