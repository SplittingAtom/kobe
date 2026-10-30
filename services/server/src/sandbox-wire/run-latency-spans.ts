import { recordSpan, runParentContext } from "@kobe/telemetry";
import { RunLatency } from "./run-latency.js";

export type { RunLatency };

/**
 * A run's latency tracker (KOBE-525) whose spans land in the run's trace (KOBE-274), timed from
 * now: the lease is taken just before run.start is delivered.
 */
export function runLatency(runId: string, resumed: boolean, compaction: boolean): RunLatency {
  return new RunLatency({
    startMs: Date.now(),
    resumed,
    compaction,
    emit: (span) =>
      recordSpan(span.name, {
        startTime: span.startMs,
        endTime: span.endMs,
        attributes: span.attributes,
        parent: runParentContext(runId),
      }),
  });
}
