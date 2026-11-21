import {
  CAPABILITY_TRACE_SPANS,
  parseTraceparent,
  runTraceId,
  serverToSandboxFrameSchema,
  threadBranchSummaryFrameSchema,
  threadCompactFrameSchema,
  type RunStartFrame,
  type ServerToSandboxFrame,
  type ThreadBranchSummaryFrame,
  type ThreadCompactFrame,
  type WireTraceContext,
} from "@kobe/protocol";
import type { CommandRow } from "../commands.js";
import { isSummaryCommand } from "../types.js";
import type { Claimed } from "./claim.js";
import type { DeliveryEnv } from "./env.js";

/** A stored command as a wire frame; a compaction's or branch summary's token is added later. */
export type DeliverableFrame =
  | ServerToSandboxFrame
  | Omit<ThreadCompactFrame, "run_token">
  | Omit<ThreadBranchSummaryFrame, "run_token">;

/** The wire frame for a stored command, with a fresh command id; undefined if invalid. */
export function frameFor(row: CommandRow, commandId: string): DeliverableFrame | undefined {
  const base = { ...row.frame, v: 1, type: row.kind, command_id: commandId };
  const candidate =
    row.kind === "pi.command"
      ? { ...base, command: { ...(row.frame.command as object), id: commandId } }
      : base;
  // A compaction's (or branch summary's) run token is minted at delivery (KOBE-213, KOBE-548):
  // the stored frame has none yet.
  const parsed =
    row.kind === "thread.compact"
      ? threadCompactFrameSchema.omit({ run_token: true }).safeParse(candidate)
      : row.kind === "thread.branch_summary"
        ? threadBranchSummaryFrameSchema.omit({ run_token: true }).safeParse(candidate)
        : serverToSandboxFrameSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  // The stored frame must be about the row's thread and run (defence in depth).
  const f = parsed.data as { thread_id?: string; run_id?: string };
  if (isSummaryCommand(row.kind) && row.runId === null) return undefined;
  if (f.thread_id !== row.threadId) return undefined;
  if (row.runId !== null && f.run_id !== row.runId) return undefined;
  return parsed.data;
}

/**
 * The trace context a start command keeps (KOBE-274): only for agents with `trace_spans`, only
 * when this replica relays spans; the command span it names becomes a kept parent.
 */
export function traceContext(
  env: DeliveryEnv,
  row: CommandRow,
  frame: object,
): WireTraceContext | undefined {
  const trace = "trace" in frame ? (frame.trace as WireTraceContext | undefined) : undefined;
  if (
    trace === undefined ||
    row.runId === null ||
    !env.ctx.traceRelay ||
    !env.host.hasCapability(CAPABILITY_TRACE_SPANS)
  ) {
    return undefined;
  }
  const parsed = parseTraceparent(trace.traceparent);
  if (parsed === undefined || parsed.traceId !== runTraceId(row.runId)) return undefined;
  env.host.traceStarted(row.runId, parsed.parentSpanId);
  return trace;
}

/**
 * The frame as sent (KOBE-707: moved out of delivery.ts): a compaction or branch summary with its
 * run token, a start with its token and the trace context it may keep. A `run.start` gets its
 * own fields after this (`run-start.ts`).
 */
export function wireFrame(
  row: CommandRow,
  frame: DeliverableFrame,
  claimed: Claimed,
  traced: WireTraceContext | undefined,
  starts: boolean,
): ServerToSandboxFrame {
  if (row.kind === "thread.compact") {
    if (claimed.runToken === undefined) throw new Error("compaction delivered without a token");
    return {
      ...withoutTrace(frame as ThreadCompactFrame),
      ...(traced ? { trace: traced } : {}),
      run_token: claimed.runToken,
    };
  }
  if (row.kind === "thread.branch_summary") {
    if (claimed.runToken === undefined) throw new Error("branch summary delivered without a token");
    return {
      ...withoutTrace(frame as ThreadBranchSummaryFrame),
      ...(traced ? { trace: traced } : {}),
      run_token: claimed.runToken,
    };
  }
  const base = starts
    ? ({
        ...withoutTrace(frame as RunStartFrame),
        ...(traced ? { trace: traced } : {}),
      } as RunStartFrame)
    : frame;
  return (
    claimed.runToken ? { ...base, run_token: claimed.runToken } : base
  ) as ServerToSandboxFrame;
}

/** A start frame without its trace context (added back only when the agent may take it). */
function withoutTrace<F extends RunStartFrame | ThreadCompactFrame | ThreadBranchSummaryFrame>(
  frame: F,
): Omit<F, "trace"> {
  const { trace: _trace, ...rest } = frame;
  return rest;
}
