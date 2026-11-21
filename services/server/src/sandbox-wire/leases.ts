import { ENDED_LEASES_MAX } from "./connection-limits.js";
import type { RunIngest } from "./ingest.js";
import { RecentlyEndedRuns } from "./recently-ended.js";

/** A run leased to one connection. */
export interface Lease {
  readonly threadId: string;
  readonly ingest: RunIngest;
  ended: boolean;
  /** A compaction run (KOBE-213): Pi's compact uses no tools, so no tool frame may name it. */
  readonly compaction: boolean;
}

/**
 * The runs and threads leased to one connection (KOBE-706: moved out of connection.ts). Ended
 * leases are kept (up to {@link ENDED_LEASES_MAX}) to answer late frames with `run_not_active`.
 */
export class LeaseBook {
  readonly runs = new Map<string, Lease>();
  readonly threads = new Set<string>();
  /** Runs this sandbox held that ended without a live lease here (KOBE-483): late frames dropped. */
  readonly recentlyEnded = new RecentlyEndedRuns();

  isLive(runId: string): boolean {
    const lease = this.runs.get(runId);
    return lease !== undefined && !lease.ended;
  }

  /** Leases the run and its thread here. */
  add(runId: string, lease: Lease): void {
    this.threads.add(lease.threadId);
    this.runs.set(runId, lease);
  }

  /** The thread's live message runs (not compactions), oldest lease first. */
  liveMessageRuns(threadId: string): string[] {
    return [...this.runs]
      .filter(([, l]) => l.threadId === threadId && !l.ended && !l.compaction)
      .map(([runId]) => runId);
  }

  /** Marks the run's lease ended; the lease, or undefined when it was never leased here. */
  end(runId: string): Lease | undefined {
    const lease = this.runs.get(runId);
    if (!lease) return undefined;
    lease.ended = true;
    this.recentlyEnded.add(runId, lease.threadId);
    return lease;
  }

  /** Forgets the oldest ended leases beyond the cap. */
  prune(): void {
    const ended = [...this.runs].filter(([, l]) => l.ended);
    for (const [id] of ended.slice(0, Math.max(0, ended.length - ENDED_LEASES_MAX))) {
      this.runs.delete(id);
    }
  }
}
