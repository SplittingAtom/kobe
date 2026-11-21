import type { SandboxErrorCode } from "@kobe/protocol";
import type { Logger } from "pino";
import type { LeaseViolation, WireMetrics } from "./context.js";
import type { RunCheck } from "./gated-frame.js";
import type { RecentlyEndedRuns } from "./recently-ended.js";

/** What the lease checks read from their connection. */
export interface RunChecksHost {
  readonly leases: ReadonlyMap<string, { threadId: string; ended: boolean; compaction: boolean }>;
  readonly threads: ReadonlySet<string>;
  readonly recentlyEnded: Pick<RecentlyEndedRuns, "match">;
  readonly metrics: WireMetrics;
  readonly sandboxId: string;
  readonly log: Pick<Logger, "warn" | "debug">;
  sendError(code: SandboxErrorCode, message: string, ref?: string): void;
  /** Answers, audits and closes the connection (`lease_violation`). */
  violate(violation: LeaseViolation, frameType: string): void;
}

/**
 * A frame's run and thread against the connection's leases (KOBE-706: moved out of
 * connection.ts): ok | ended (late frame of a run of this connection, answered `run_not_active`)
 * | violation (already handled: the connection is closing).
 */
export class RunChecks {
  readonly #h: RunChecksHost;

  constructor(host: RunChecksHost) {
    this.#h = host;
  }

  /**
   * `run` for frames a tool sends (policy checks, artifacts, files, memory, proposals, web
   * search): a compaction run (KOBE-213) makes no tool calls, so one naming it fails closed, as if
   * the run had ended, and is logged as a security event.
   */
  toolRun(runId: string, threadId: string, frameType: string): RunCheck {
    const check = this.run(runId, threadId, frameType);
    if (check !== "ok" || this.#h.leases.get(runId)?.compaction !== true) return check;
    this.#h.log.warn(
      { run_id: runId, frame_type: frameType, sandbox_id: this.#h.sandboxId, security: true },
      "tool frame for a compaction run refused",
    );
    this.#h.sendError("run_not_active", "a compaction run makes no tool calls", frameType);
    return "ended";
  }

  run(runId: string, threadId: string, frameType: string): RunCheck {
    const lease = this.#h.leases.get(runId);
    if (!lease) return this.#recentlyEnded(runId, threadId, frameType);
    if (lease.threadId !== threadId) {
      this.#h.violate("unknown_thread", frameType);
      return "violation";
    }
    if (lease.ended) {
      this.#h.metrics.lateFrames += 1;
      this.#h.sendError("run_not_active", "the run has ended", frameType);
      return "ended";
    }
    return "ok";
  }

  thread(threadId: string, frameType: string): boolean {
    if (this.#h.threads.has(threadId)) return true;
    this.#h.violate("unknown_thread", frameType);
    return false;
  }

  /**
   * No lease here: a run this sandbox held that just ended (interrupted by this connection's hello,
   * or an ended lease the count cap evicted) gets its late frame dropped within the grace window
   * (KOBE-483); anything else is a lease violation and closes the connection.
   */
  #recentlyEnded(runId: string, threadId: string, frameType: string): "ended" | "violation" {
    const recent = this.#h.recentlyEnded.match(runId, threadId);
    if (recent === "match") {
      this.#h.metrics.lateFrames += 1;
      this.#h.log.debug(
        { run_id: runId, frame_type: frameType },
        "late frame of an ended run dropped",
      );
      this.#h.sendError("run_not_active", "the run has ended", frameType);
      return "ended";
    }
    this.#h.violate(recent === "thread_mismatch" ? "unknown_thread" : "unknown_run", frameType);
    return "violation";
  }
}
