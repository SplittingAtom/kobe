import type { SandboxErrorCode, ServerToSandboxFrame } from "@kobe/protocol";
import type { CommandDelivery } from "../delivery.js";
import { RunIngest } from "../ingest.js";
import type { RunLatency } from "../run-latency-spans.js";
import { createRunTranslator } from "../translate.js";
import type { ConnectionPort } from "./port.js";

/** What a run's ingest needs from its connection beyond the port (KOBE-706). */
export interface RunIngestHost {
  readonly port: ConnectionPort;
  readonly delivery: Pick<CommandDelivery, "fetchNewEntries" | "forgetSession">;
  sendError(code: SandboxErrorCode, message: string, ref?: string): void;
  /** The run ended here or elsewhere: late frames get `run_not_active`. */
  endLease(runId: string): void;
  close(reason: "internal", message: string): void;
  /** A storage cap: fail the run and stop Pi. */
  limitExceeded(
    runId: string,
    threadId: string,
    limit: "run_events" | "run_bytes" | "thread_entries",
  ): void;
}

/** The ingest of one leased run's `pi.event` frames (translation, storage, acks). */
export function newRunIngest(
  h: RunIngestHost,
  runId: string,
  threadId: string,
  cursor: number,
  latency: RunLatency,
): RunIngest {
  const { ctx, target, log } = h.port;
  const send = (frame: ServerToSandboxFrame) => h.port.send(frame);
  return new RunIngest({
    db: ctx.db,
    teamId: target.teamId,
    runId,
    threadId,
    cursor,
    onFrame: (events, nowMs) => latency.observe(events, nowMs),
    tuning: ctx.tuning,
    serverCalls: ctx.serverCalls,
    createTranslator: () =>
      createRunTranslator({
        teamId: target.teamId,
        registry: ctx.tools,
        onDropped: (dropped) => {
          ctx.metrics.eventsDropped += 1;
          log.warn({ run_id: runId, ...dropped }, "dropped a translated event");
        },
      }),
    host: {
      metrics: ctx.metrics,
      log,
      sendAck: (run, seq) => send({ v: 1, type: "ack", run_id: run, seq }),
      sendResend: (run, from) => send({ v: 1, type: "resend", run_id: run, from_seq: from }),
      sendError: (code, message, ref) => h.sendError(code, message, ref),
      fetchNewEntries: (thread) => h.delivery.fetchNewEntries(thread),
      runEnded: (run, status) => {
        h.endLease(run);
        if (status === undefined) return;
        if (status === "completed") ctx.metrics.runsCompleted += 1;
        ctx.runEnded({ teamId: target.teamId, runId: run, threadId, status });
      },
      failed: () => h.close("internal", "events could not be stored"),
      needsSync: (thread) => h.delivery.forgetSession(thread),
      limitExceeded: (run, limit) => h.limitExceeded(run, threadId, limit),
    },
  });
}
