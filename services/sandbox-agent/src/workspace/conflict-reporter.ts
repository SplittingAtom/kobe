import type { WorkspaceConflictFrame } from "@kobe/protocol";
import type { ConflictReport } from "./sync.js";

/**
 * Sends the sync's conflict copies to the server (KOBE-492, `workspace.conflict`): at once when
 * the wire is up, else queued (bounded; the oldest goes) until the next `hello.ack`. Names and
 * hashes only. The server answers nothing: a frame it will not take is dropped there.
 */
export const CONFLICT_QUEUE_MAX = 20;

export interface ConflictReporterDeps {
  readonly ready: () => boolean;
  readonly send: (frame: WorkspaceConflictFrame) => boolean;
}

export class ConflictReporter {
  readonly #deps: ConflictReporterDeps;
  #queue: WorkspaceConflictFrame[] = [];

  constructor(deps: ConflictReporterDeps) {
    this.#deps = deps;
  }

  report(r: ConflictReport): void {
    const frame: WorkspaceConflictFrame = {
      v: 1,
      type: "workspace.conflict",
      path: r.path,
      conflict_path: r.conflict_path,
      member_sha256: r.member_sha256,
      agent_sha256: r.agent_sha256,
      at: r.at.toISOString(),
    };
    if (this.#deps.ready() && this.#deps.send(frame)) return;
    this.#queue = [...this.#queue, frame].slice(-CONFLICT_QUEUE_MAX);
  }

  /** The wire is (back) up: send what waited, oldest first. */
  flush(): void {
    const pending = this.#queue;
    this.#queue = [];
    for (const [i, frame] of pending.entries()) {
      if (!this.#deps.send(frame)) {
        this.#queue = pending.slice(i);
        return;
      }
    }
  }

  get pending(): number {
    return this.#queue.length;
  }
}
