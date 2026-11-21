import type { TraceSpansFrame } from "@kobe/protocol";
import type { LeaseViolation, WireMetrics } from "../context.js";
import type { RunOwner, TraceFrameRate, TraceIntake } from "../trace-intake.js";

/** What a `trace.spans` frame needs from its connection (KOBE-706: moved out of connection.ts). */
export interface TraceSpansPort {
  /** The replica's run state; absent when the replica does not relay. */
  readonly traces: TraceIntake | undefined;
  readonly rate: TraceFrameRate | undefined;
  /** Whether the agent announced `trace_spans`. */
  readonly announced: boolean;
  readonly metrics: WireMetrics;
  readonly owner: RunOwner;
  /** The thread of the run's lease here (live or ended), or undefined without one. */
  leaseThread(runId: string): string | undefined;
  violate(violation: LeaseViolation, frameType: string): void;
}

/**
 * `trace.spans` (KOBE-274): never answered, never closing the connection, except for a run or
 * thread this connection never held (a lease violation like any other frame's). Classified by
 * the decoded type (key order cannot skip the rate); the spans are parsed later, one by one.
 */
export function onTraceSpans(c: TraceSpansPort, frame: TraceSpansFrame): void {
  const traces = c.traces;
  if (traces === undefined || c.rate === undefined || !c.announced) {
    c.metrics.traceFramesDropped += 1;
    return;
  }
  if (!c.rate.admit()) return;
  const threadId = c.leaseThread(frame.run_id);
  if (threadId === undefined) {
    // Note: a late frame for a run whose lease the ended-lease count cap evicted AND whose 30 s
    // trace grace passed is a violation; that needs 256 ended runs on one connection meanwhile.
    if (traces.recentlyEnded(frame.run_id, frame.thread_id, c.owner)) {
      traces.dropFrame(frame.run_id, frame.spans.length);
    } else {
      c.violate("unknown_run", "trace.spans");
    }
    return;
  }
  if (threadId !== frame.thread_id) {
    c.violate("unknown_thread", "trace.spans");
    return;
  }
  traces.accept(frame, c.owner);
}
