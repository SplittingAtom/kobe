import type {
  FileOpenFrame,
  FileOpenResultFrame,
  KobeToolsRequest,
  KobeToolsResponse,
} from "@kobe/protocol";
import type { PushedFile } from "../workspace/sync.js";
import { toolsError } from "./channel.js";
import { resolveWorkspaceFile, SharePathError } from "./share-path.js";

/**
 * The agent side of `open_file` (KOBE-484, file-open-frames.ts `file.open`, `file.open_result`).
 * One request becomes, in order: confine the path (`share-path.ts`, no size limit: a missing file
 * is a tool error here), push that file through workspace sync so the member opens what the
 * agent just wrote, then send `file.open` and relay the server's answer. A failed push (sync off,
 * too large, read-only area) still asks the server, which opens the synced copy if there is one.
 * Same rules as {@link FileShareBroker}: wire ids minted here, the agent's own run and thread,
 * exactly one answer per request (fail closed).
 */
export const MAX_PENDING_OPENS = 16;
export const MAX_PENDING_OPENS_PER_THREAD = 4;

type OpenRequest = Extract<KobeToolsRequest, { op: "file.open" }>;

interface Pending {
  readonly threadId: string;
  readonly runId: string;
  readonly extensionId: string;
  readonly reply: (response: KobeToolsResponse) => void;
}

export interface FileOpenBrokerDeps {
  /** The workspace root (`KOBE_WORKSPACE_DIR`). */
  readonly root: string;
  /** Send a frame now; false when the wire is not ready. */
  readonly send: (frame: FileOpenFrame) => boolean;
  /** Undefined when workspace sync is off: the server's synced copy is opened as it is. */
  readonly pushPath: ((rel: string) => Promise<PushedFile>) | undefined;
}

export class FileOpenBroker {
  readonly #deps: FileOpenBrokerDeps;
  readonly #pending = new Map<string, Pending>();
  #next = 1;

  constructor(deps: FileOpenBrokerDeps) {
    this.#deps = deps;
  }

  open(
    threadId: string,
    runId: string | undefined,
    request: OpenRequest,
    reply: (response: KobeToolsResponse) => void,
  ): void {
    if (runId === undefined) {
      reply(toolsError(request.id, "not_allowed", "no active run on this thread"));
      return;
    }
    const perThread = [...this.#pending.values()].filter((p) => p.threadId === threadId).length;
    if (this.#pending.size >= MAX_PENDING_OPENS || perThread >= MAX_PENDING_OPENS_PER_THREAD) {
      reply(toolsError(request.id, "unavailable", "too many files are being opened"));
      return;
    }
    const requestId = `fo_${this.#next++}`;
    // Registered before the (slow) push, so a run that ends meanwhile answers it exactly once.
    this.#pending.set(requestId, { threadId, runId, extensionId: request.id, reply });
    void this.#run(requestId, threadId, runId, request);
  }

  async #run(requestId: string, threadId: string, runId: string, request: OpenRequest) {
    const fail = (code: string, message: string) => {
      const pending = this.#pending.get(requestId);
      if (pending === undefined) return;
      this.#pending.delete(requestId);
      pending.reply(toolsError(pending.extensionId, code, message));
    };
    let rel: string;
    try {
      rel = (await resolveWorkspaceFile(this.#deps.root, request.input.path)).rel;
    } catch (error) {
      if (error instanceof SharePathError) fail(error.code, error.message);
      else fail("invalid_path", "the file could not be read");
      return;
    }
    try {
      await this.#deps.pushPath?.(rel);
    } catch {
      // The server decides from its synced copy (not_found when there is none).
    }
    if (!this.#pending.has(requestId)) return; // answered while pushing: send nothing
    const frame: FileOpenFrame = {
      v: 1,
      type: "file.open",
      request_id: requestId,
      run_id: runId,
      thread_id: threadId,
      tool_call_id: request.tool_call_id,
      tool: request.tool,
      input: request.input,
    };
    if (!this.#deps.send(frame)) fail("unavailable", "Kobe server not reachable");
  }

  /** `file.open_result` from the server; false when nothing waits for it. */
  onResult(frame: FileOpenResultFrame): boolean {
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
