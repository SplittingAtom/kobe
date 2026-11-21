import { LEGACY_WEB_SEARCH_MESSAGE, type LegacyWebSearchQueryFrame } from "@kobe/protocol";
import { MAX_SYNC_REQUESTS } from "../connection-limits.js";
import type { ConnectionPort } from "./port.js";

/**
 * Refresh in the Files panel (KOBE-599) on one connection: asks the agent to push now. The answer
 * (`workspace.synced`) goes back to the requester as a bus hint; an agent that cannot (older, not
 * ready, too many asks in flight) is answered `unsynced` at once, so the requester lists without
 * waiting. (KOBE-706: moved out of connection.ts.)
 */
export class WorkspaceSyncAsks {
  readonly #port: ConnectionPort;
  /** `workspace.sync_now` asks sent here and not answered yet. */
  readonly #pending = new Set<string>();

  constructor(port: ConnectionPort) {
    this.#port = port;
  }

  /** `ready`: the connection is ready and the agent announced `workspace_sync_now`. */
  ask(requestId: string, ready: boolean): void {
    if (!ready || this.#pending.size >= MAX_SYNC_REQUESTS) {
      this.#answered(requestId, false);
      return;
    }
    this.#pending.add(requestId);
    if (!this.#port.send({ v: 1, type: "workspace.sync_now", request_id: requestId })) {
      this.#pending.delete(requestId);
      this.#answered(requestId, false);
    }
  }

  /** Only answers to asks sent on this connection are passed on; anything else is dropped. */
  synced(requestId: string, ok: boolean): void {
    if (!this.#pending.delete(requestId)) return;
    this.#answered(requestId, ok);
  }

  /** The connection closed: waiting Refreshes list now instead of at their timeout. */
  close(): void {
    for (const id of this.#pending) this.#answered(id, false);
    this.#pending.clear();
  }

  #answered(requestId: string, ok: boolean): void {
    const { ctx, log } = this.#port;
    ctx.bus
      .notify(ctx.db, { kind: ok ? "synced" : "unsynced", id: requestId })
      .catch((err: unknown) => log.warn({ err }, "could not pass on a workspace sync answer"));
  }
}

/**
 * `web_search.query` from an agent built before KOBE-606 removed the built-in web search. The
 * server no longer knows `web_search` (policy denies it as an unknown tool), so this only comes
 * from an old agent mid-rollout or a confused one: answer unavailable and keep the connection.
 */
export function onLegacyWebSearch(port: ConnectionPort, frame: LegacyWebSearchQueryFrame): void {
  port.log.debug({ run_id: frame.run_id }, "legacy web_search.query answered unavailable");
  port.send({
    v: 1,
    type: "web_search.result",
    request_id: frame.request_id,
    ok: true,
    available: false,
    reason: "not_configured",
    message: LEGACY_WEB_SEARCH_MESSAGE,
  });
}
