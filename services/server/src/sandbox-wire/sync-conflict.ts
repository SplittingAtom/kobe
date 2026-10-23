import {
  syncConflictSchema,
  type ServerToSandboxFrame,
  type SyncConflict,
  type WorkspaceConflictFrame,
} from "@kobe/protocol";
import type { KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import { isInternalPath, isReadOnlyPath } from "../workspace-files/paths.js";
import { markTold, recordConflict, untoldNotes } from "../sync-conflicts/store.js";
import type { SandboxTarget } from "./types.js";

/**
 * `workspace.conflict` (KOBE-492, sync-conflicts.ts) on one connection. Never answered and never
 * closing the connection: a frame the server will not take (no capability, an eval sandbox, over
 * the per-connection rate, a hostile, internal or read-only name, not a conflict copy) is dropped
 * and logged. Otherwise it is recorded for the thread whose run last wrote the path; if that
 * thread has a run active on this connection, its agent is told at once (`workspace.conflict_note`).
 */
export interface SyncConflictConnection {
  readonly db: KobeDb;
  readonly target: SandboxTarget;
  readonly log: Pick<Logger, "error" | "warn" | "info">;
  readonly hasCapability: boolean;
  readonly rate: ConflictRate;
  /** The thread's run that is active on this connection, if any. */
  activeRun(threadId: string): string | undefined;
  send(frame: ServerToSandboxFrame): boolean;
}

export type ConflictDrop =
  "capability_missing" | "eval_sandbox" | "rate" | "invalid" | "internal_path" | "read_only";

/** Token bucket: `burst` frames, refilled at `perMinute`. */
export class ConflictRate {
  #tokens: number;
  #at: number;
  constructor(
    readonly burst = 10,
    readonly perMinute = 10,
    readonly now: () => number = Date.now,
  ) {
    this.#tokens = burst;
    this.#at = now();
  }

  admit(): boolean {
    const t = this.now();
    this.#tokens = Math.min(this.burst, this.#tokens + ((t - this.#at) / 60_000) * this.perMinute);
    this.#at = t;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

/** The frame's conflict if it may be recorded, else why not (names never logged). */
export function checkConflict(frame: WorkspaceConflictFrame): SyncConflict | ConflictDrop {
  const parsed = syncConflictSchema.safeParse({
    path: frame.path,
    conflict_path: frame.conflict_path,
    member_sha256: frame.member_sha256,
    agent_sha256: frame.agent_sha256,
  });
  if (!parsed.success) return "invalid";
  const c = parsed.data;
  if (isInternalPath(c.path) || isInternalPath(c.conflict_path)) return "internal_path";
  // Server-owned areas mirror the server: the sandbox never keeps an edit there as a copy.
  if (isReadOnlyPath(c.path) || isReadOnlyPath(c.conflict_path)) return "read_only";
  return c;
}

export function onWorkspaceConflict(
  c: SyncConflictConnection,
  frame: WorkspaceConflictFrame,
): void {
  const drop = (reason: ConflictDrop) =>
    c.log.warn({ reason, security: reason !== "rate" }, "workspace.conflict dropped");
  if (!c.hasCapability) return drop("capability_missing");
  if (c.target.evalThreadId !== undefined) return drop("eval_sandbox");
  if (!c.rate.admit()) return drop("rate");
  const checked = checkConflict(frame);
  if (typeof checked === "string") return drop(checked);
  void deliver(c, checked).catch((err: unknown) =>
    c.log.error({ err }, "workspace.conflict could not be recorded"),
  );
}

async function deliver(c: SyncConflictConnection, conflict: SyncConflict): Promise<void> {
  const owner = { teamId: c.target.teamId, userId: c.target.userId };
  const recorded = await recordConflict(c.db, owner, conflict);
  if (recorded === undefined) {
    c.log.warn({ reason: "member_rate", security: false }, "workspace.conflict dropped");
    return;
  }
  c.log.info(
    { conflict_id: recorded.id, thread_id: recorded.threadId ?? null },
    "workspace sync conflict recorded",
  );
  if (recorded.threadId === undefined) return;
  const runId = c.activeRun(recorded.threadId);
  if (runId === undefined) return; // told at the thread's next run.start
  const notes = await untoldNotes(c.db, owner, recorded.threadId, [recorded.id]);
  if (notes.conflicts.length === 0) return;
  const sent = c.send({
    v: 1,
    type: "workspace.conflict_note",
    run_id: runId,
    thread_id: recorded.threadId,
    conflicts: [...notes.conflicts],
  });
  // Not sent (the connection closed): it stays untold and goes with the next run.start.
  if (sent) await markTold(c.db, owner, notes.ids);
}
