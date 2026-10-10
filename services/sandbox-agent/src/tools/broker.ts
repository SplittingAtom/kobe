import type {
  ArtifactPutFrame,
  ArtifactResultFrame,
  KobeToolsRequest,
  KobeToolsResponse,
} from "@kobe/protocol";
import { toolsError } from "./channel.js";

/**
 * Routes kobe-tools requests to the server and its answers back (frames.ts `artifact.put`,
 * `artifact.result`). Wire `request_id`s are minted here, so two threads' extensions can never
 * collide or answer each other's requests; the frame carries the run and thread the agent knows,
 * never ones the extension names. Every pending request is answered exactly once; anything that
 * prevents an answer from the server is an error (fail closed). One frame per request: there is no
 * retry, so a re-sent `artifact.put` cannot happen on this side (the server is idempotent on the
 * tool call anyway, D-3).
 */
export const MAX_ARTIFACT_PUT_FRAME_BYTES = 1024 * 1024;
export const MAX_PENDING_PUTS = 64;
export const MAX_PENDING_PUTS_PER_THREAD = 8;

interface Pending {
  readonly threadId: string;
  readonly runId: string;
  readonly extensionId: string;
  readonly reply: (response: KobeToolsResponse) => void;
}

export interface ArtifactBrokerDeps {
  /** Send a frame now; false when the wire is not ready. */
  readonly send: (frame: ArtifactPutFrame) => boolean;
}

export class ArtifactBroker {
  readonly #deps: ArtifactBrokerDeps;
  readonly #pending = new Map<string, Pending>();
  #next = 1;

  constructor(deps: ArtifactBrokerDeps) {
    this.#deps = deps;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  put(
    threadId: string,
    runId: string | undefined,
    request: KobeToolsRequest,
    reply: (response: KobeToolsResponse) => void,
  ): void {
    if (runId === undefined) {
      reply(toolsError(request.id, "not_allowed", "no active run on this thread"));
      return;
    }
    const perThread = [...this.#pending.values()].filter((p) => p.threadId === threadId).length;
    if (this.#pending.size >= MAX_PENDING_PUTS || perThread >= MAX_PENDING_PUTS_PER_THREAD) {
      reply(toolsError(request.id, "unavailable", "too many artifact requests in flight"));
      return;
    }
    const requestId = `ap_${this.#next++}`;
    const frame = {
      v: 1,
      type: "artifact.put",
      request_id: requestId,
      run_id: runId,
      thread_id: threadId,
      tool_call_id: request.tool_call_id,
      tool: "tool" in request ? request.tool : undefined,
      input: request.input,
    } as ArtifactPutFrame;
    if (Buffer.byteLength(JSON.stringify(frame)) > MAX_ARTIFACT_PUT_FRAME_BYTES) {
      reply(toolsError(request.id, "too_large", "the call is too large to send"));
      return;
    }
    this.#pending.set(requestId, { threadId, runId, extensionId: request.id, reply });
    if (!this.#deps.send(frame)) {
      this.#pending.delete(requestId);
      reply(toolsError(request.id, "unavailable", "Kobe server not reachable"));
    }
  }

  /** `artifact.result` from the server; false when nothing waits for it (late, or unknown). */
  onResult(frame: ArtifactResultFrame): boolean {
    const pending = this.#pending.get(frame.request_id);
    if (pending === undefined) return false;
    this.#pending.delete(frame.request_id);
    pending.reply(
      frame.ok
        ? {
            id: pending.extensionId,
            ok: true,
            artifact_id: frame.artifact_id,
            version: frame.version,
          }
        : { id: pending.extensionId, ok: false, error: frame.error },
    );
    return true;
  }

  /** Connection lost: the server may have dropped the requests with it. */
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
