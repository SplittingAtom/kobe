import type {
  KobeToolsRequest,
  KobeToolsResponse,
  MemoryPutFrame,
  MemoryReadFrame,
  MemoryResultFrame,
} from "@kobe/protocol";
import { toolsError } from "./channel.js";

/**
 * Routes `remember` / `recall` kobe-tools requests (`memory.put`, `memory.read`) to the server and
 * its `memory.result` back (KOBE-157, memory.ts). Same rules as {@link WebSearchBroker}: wire ids
 * are minted here, the frame carries the run and thread the agent knows (never ones the extension
 * names) plus the `tool_call_id` kobe-policy allowed, every pending request is answered exactly
 * once, and anything that prevents an answer is an error (fail closed). No retry.
 */
export const MAX_PENDING_MEMORY = 32;
export const MAX_PENDING_MEMORY_PER_THREAD = 4;

type MemoryRequest = Extract<KobeToolsRequest, { op: "memory.put" | "memory.read" }>;

interface Pending {
  readonly threadId: string;
  readonly runId: string;
  readonly extensionId: string;
  readonly reply: (response: KobeToolsResponse) => void;
}

export interface MemoryBrokerDeps {
  /** Send a frame now; false when the wire is not ready. */
  readonly send: (frame: MemoryPutFrame | MemoryReadFrame) => boolean;
}

export class MemoryBroker {
  readonly #deps: MemoryBrokerDeps;
  readonly #pending = new Map<string, Pending>();
  #next = 1;

  constructor(deps: MemoryBrokerDeps) {
    this.#deps = deps;
  }

  request(
    threadId: string,
    runId: string | undefined,
    request: MemoryRequest,
    reply: (response: KobeToolsResponse) => void,
  ): void {
    if (runId === undefined) {
      reply(toolsError(request.id, "not_allowed", "no active run on this thread"));
      return;
    }
    const perThread = [...this.#pending.values()].filter((p) => p.threadId === threadId).length;
    if (this.#pending.size >= MAX_PENDING_MEMORY || perThread >= MAX_PENDING_MEMORY_PER_THREAD) {
      reply(toolsError(request.id, "unavailable", "too many memory requests in flight"));
      return;
    }
    const requestId = `mem_${this.#next++}`;
    const base = {
      v: 1 as const,
      request_id: requestId,
      run_id: runId,
      thread_id: threadId,
      tool_call_id: request.tool_call_id,
    };
    const frame: MemoryPutFrame | MemoryReadFrame =
      request.op === "memory.put"
        ? { ...base, type: "memory.put", input: request.input }
        : { ...base, type: "memory.read", input: request.input };
    this.#pending.set(requestId, { threadId, runId, extensionId: request.id, reply });
    if (!this.#deps.send(frame)) {
      this.#pending.delete(requestId);
      reply(toolsError(request.id, "unavailable", "Kobe server not reachable"));
    }
  }

  /** `memory.result` from the server; false when nothing waits for it. */
  onResult(frame: MemoryResultFrame): boolean {
    const pending = this.#pending.get(frame.request_id);
    if (pending === undefined) return false;
    this.#pending.delete(frame.request_id);
    const { v: _v, type: _type, request_id: _request, ...body } = frame;
    pending.reply({ id: pending.extensionId, ...body } as KobeToolsResponse);
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
