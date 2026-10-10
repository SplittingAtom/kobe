import type {
  KobeToolsRequest,
  KobeToolsResponse,
  WebSearchQueryFrame,
  WebSearchResultFrame,
} from "@kobe/protocol";
import { toolsError } from "./channel.js";

/**
 * Routes `web_search` kobe-tools requests to the server and its answers back (frames.ts
 * `web_search.query`, `web_search.result`). Same rules as {@link ArtifactBroker}: wire ids are
 * minted here, the frame carries the run and thread the agent knows, every pending request is
 * answered exactly once, and anything that prevents an answer is an error (fail closed).
 */
export const MAX_PENDING_SEARCHES = 32;
export const MAX_PENDING_SEARCHES_PER_THREAD = 4;

type SearchRequest = Extract<KobeToolsRequest, { op: "web_search" }>;

interface Pending {
  readonly threadId: string;
  readonly runId: string;
  readonly extensionId: string;
  readonly reply: (response: KobeToolsResponse) => void;
}

export interface WebSearchBrokerDeps {
  /** Send a frame now; false when the wire is not ready. */
  readonly send: (frame: WebSearchQueryFrame) => boolean;
}

export class WebSearchBroker {
  readonly #deps: WebSearchBrokerDeps;
  readonly #pending = new Map<string, Pending>();
  #next = 1;

  constructor(deps: WebSearchBrokerDeps) {
    this.#deps = deps;
  }

  query(
    threadId: string,
    runId: string | undefined,
    request: SearchRequest,
    reply: (response: KobeToolsResponse) => void,
  ): void {
    if (runId === undefined) {
      reply(toolsError(request.id, "not_allowed", "no active run on this thread"));
      return;
    }
    const perThread = [...this.#pending.values()].filter((p) => p.threadId === threadId).length;
    if (
      this.#pending.size >= MAX_PENDING_SEARCHES ||
      perThread >= MAX_PENDING_SEARCHES_PER_THREAD
    ) {
      reply(toolsError(request.id, "unavailable", "too many searches in flight"));
      return;
    }
    const requestId = `ws_${this.#next++}`;
    const frame: WebSearchQueryFrame = {
      v: 1,
      type: "web_search.query",
      request_id: requestId,
      run_id: runId,
      thread_id: threadId,
      tool_call_id: request.tool_call_id,
      tool: request.tool,
      input: request.input,
    };
    this.#pending.set(requestId, { threadId, runId, extensionId: request.id, reply });
    if (!this.#deps.send(frame)) {
      this.#pending.delete(requestId);
      reply(toolsError(request.id, "unavailable", "Kobe server not reachable"));
    }
  }

  /** `web_search.result` from the server; false when nothing waits for it. */
  onResult(frame: WebSearchResultFrame): boolean {
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
