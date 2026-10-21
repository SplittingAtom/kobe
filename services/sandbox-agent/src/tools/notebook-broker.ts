import type {
  KobeToolsRequest,
  KobeToolsResponse,
  NotebookRunFrame,
  NotebookRunResultFrame,
} from "@kobe/protocol";
import { PushPathError, type PushedFile } from "../workspace/sync.js";
import { toolsError } from "./channel.js";
import { resolveSharePath, SharePathError } from "./share-path.js";

/**
 * The agent side of `run_python` (KOBE-464; docs/specs/notebooks.md NB13). A `code` call goes to
 * the server as is; a `path` call first confines the path and pushes that file through workspace
 * sync (the server runs the synced copy, as `share_file` shares it). The server answers once the
 * execution ended (it sends the `notebook.execute` back to this sandbox meanwhile). Same rules as
 * the other brokers: wire ids are minted here, the frame carries the run and thread the agent
 * knows, every pending request is answered exactly once, and any failure is an error answer.
 */
export const MAX_PENDING_RUNS = 16;
export const MAX_PENDING_RUNS_PER_THREAD = 2;

type RunRequest = Extract<KobeToolsRequest, { op: "notebook.run" }>;

interface Pending {
  readonly threadId: string;
  readonly runId: string;
  readonly extensionId: string;
  readonly reply: (response: KobeToolsResponse) => void;
}

export interface NotebookBrokerDeps {
  readonly root: string;
  readonly send: (frame: NotebookRunFrame) => boolean;
  /** Absent without workspace sync: `path` calls are refused. */
  readonly pushPath?: ((rel: string) => Promise<PushedFile>) | undefined;
}

export class NotebookBroker {
  readonly #deps: NotebookBrokerDeps;
  readonly #pending = new Map<string, Pending>();
  #next = 1;

  constructor(deps: NotebookBrokerDeps) {
    this.#deps = deps;
  }

  run(
    threadId: string,
    runId: string | undefined,
    request: RunRequest,
    reply: (response: KobeToolsResponse) => void,
  ): void {
    if (runId === undefined) {
      reply(toolsError(request.id, "not_allowed", "no active run on this thread"));
      return;
    }
    const perThread = [...this.#pending.values()].filter((p) => p.threadId === threadId).length;
    if (this.#pending.size >= MAX_PENDING_RUNS || perThread >= MAX_PENDING_RUNS_PER_THREAD) {
      reply(toolsError(request.id, "unavailable", "too many executions in flight"));
      return;
    }
    const requestId = `nb_${this.#next++}`;
    this.#pending.set(requestId, { threadId, runId, extensionId: request.id, reply });
    void this.#send(requestId, threadId, runId, request);
  }

  async #send(requestId: string, threadId: string, runId: string, request: RunRequest) {
    const fail = (code: string, message: string) => {
      const pending = this.#pending.get(requestId);
      if (pending === undefined) return;
      this.#pending.delete(requestId);
      pending.reply(toolsError(pending.extensionId, code, message));
    };
    try {
      const path = request.input.path;
      if (path !== undefined) {
        if (this.#deps.pushPath === undefined) {
          fail("not_synced", "running a file needs workspace sync, which this sandbox lacks");
          return;
        }
        const { rel } = await resolveSharePath(this.#deps.root, path);
        await this.#deps.pushPath(rel);
        if (!this.#pending.has(requestId)) return; // answered while pushing: send nothing
      }
      const frame: NotebookRunFrame = {
        v: 1,
        type: "notebook.run",
        request_id: requestId,
        run_id: runId,
        thread_id: threadId,
        tool_call_id: request.tool_call_id,
        tool: request.tool,
        input: request.input,
      };
      if (!this.#deps.send(frame)) fail("unavailable", "Kobe server not reachable");
    } catch (error) {
      if (error instanceof SharePathError) fail(error.code, error.message);
      else if (error instanceof PushPathError) fail("not_synced", error.message);
      else fail("not_synced", "the file could not be pushed to the Kobe server");
    }
  }

  /** `notebook.run_result` from the server; false when nothing waits for it. */
  onResult(frame: NotebookRunResultFrame): boolean {
    const pending = this.#pending.get(frame.request_id);
    if (pending === undefined) return false;
    this.#pending.delete(frame.request_id);
    const { v: _v, type: _type, request_id: _request, ...body } = frame;
    pending.reply({ id: pending.extensionId, ...body });
    return true;
  }

  failAll(message: string): void {
    this.#failWhere(() => true, message);
  }

  failRun(runId: string, message: string): void {
    this.#failWhere((p) => p.runId === runId, message);
  }

  failThread(threadId: string, message: string): void {
    this.#failWhere((p) => p.threadId === threadId, message);
  }

  #failWhere(match: (pending: Pending) => boolean, message: string): void {
    for (const [id, pending] of this.#pending) {
      if (!match(pending)) continue;
      this.#pending.delete(id);
      pending.reply(toolsError(pending.extensionId, "unavailable", message));
    }
  }
}
