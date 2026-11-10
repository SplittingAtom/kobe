import { randomUUID } from "node:crypto";
import { withTeam, type KobeDb } from "@kobe/db";
import type { WorkspaceSyncStatus } from "@kobe/protocol";
import type { BusHint, SandboxBus } from "./bus.js";
import { liveConnection } from "./commands.js";

/** The member's own sandbox: never an eval sandbox (those have no workspace sync). */
export interface SyncNowTarget {
  readonly teamId: string;
  readonly userId: string;
}

/**
 * Refresh = sync now (KOBE-599), the requester's side. Callable on any replica: it finds the
 * member's live connection, hints its holder (`sync` bus hint, which sends `workspace.sync_now`),
 * and waits for the `synced`/`unsynced` hint the holder sends back when the agent answers, at
 * most `timeoutMs`. The request id is random and lives only in this process, so an answer can
 * reach no other waiter; a lost hint costs the timeout, never a wrong answer. No sandbox running:
 * `asleep` at once (its last push is current).
 */
export class SyncNowRequests {
  readonly #find: (target: SyncNowTarget) => Promise<string | undefined>;
  readonly #notify: (hint: BusHint) => Promise<void>;
  readonly #waiting = new Map<string, (ok: boolean | undefined) => void>();

  /**
   * `find`: the id of the member's live connection, if any; `notify`: sends a bus hint now.
   * {@link syncNowRequests} binds both to Postgres.
   */
  constructor(
    find: (target: SyncNowTarget) => Promise<string | undefined>,
    notify: (hint: BusHint) => Promise<void>,
  ) {
    this.#find = find;
    this.#notify = notify;
  }

  get waiting(): number {
    return this.#waiting.size;
  }

  /** A `synced`/`unsynced` hint: the waiter of `requestId` (if it is in this process) resolves. */
  answered(requestId: string, ok: boolean): void {
    this.#waiting.get(requestId)?.(ok);
  }

  async request(target: SyncNowTarget, timeoutMs: number): Promise<WorkspaceSyncStatus> {
    const connectionId = await this.#find({ teamId: target.teamId, userId: target.userId });
    if (connectionId === undefined) return "asleep";
    const requestId = randomUUID();
    const answer = new Promise<WorkspaceSyncStatus>((resolve) => {
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      timer.unref();
      const finish = (ok: boolean | undefined) => {
        clearTimeout(timer);
        this.#waiting.delete(requestId);
        resolve(ok === undefined ? "timeout" : ok ? "synced" : "not_synced");
      };
      this.#waiting.set(requestId, finish);
    });
    try {
      await this.#notify({ kind: "sync", id: connectionId, request: requestId });
    } catch {
      this.answered(requestId, false);
    }
    return answer;
  }

  /** Shutting down: every waiter lists now. */
  close(): void {
    for (const finish of [...this.#waiting.values()]) finish(false);
  }
}

/** {@link SyncNowRequests} over Postgres: the live connection row and the sandbox bus. */
export function syncNowRequests(db: KobeDb, bus: SandboxBus, staleMs: number): SyncNowRequests {
  return new SyncNowRequests(
    async (target) => {
      const live = await withTeam(db, target.teamId, (tx) => liveConnection(tx, target, staleMs));
      return live?.connectionId;
    },
    (hint) => bus.notify(db, hint),
  );
}
