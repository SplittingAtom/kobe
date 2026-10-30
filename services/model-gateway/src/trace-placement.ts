import type { IncomingHttpHeaders } from "node:http";
import type { RunSession } from "@kobe/db";
import { parseTraceparent, runTraceId, type ServerCallClaims } from "@kobe/protocol";
import { mapSandboxSpanId } from "@kobe/protocol/node";
import {
  ROOT_CONTEXT,
  idAttributes,
  runParentContext,
  sessionAttributes,
  telemetryState,
  type Attributes,
  type Context,
} from "@kobe/telemetry";

/** What the gateway needs to place its spans in run traces (KOBE-274). */
export interface GatewayTracing {
  /** `k_trace` (`deriveTraceSpanKey` over KOBE_TRACE_SPAN_KEY): remaps sandbox span ids. */
  readonly spanKey: Uint8Array;
  /** The run's thread and owner from the server's record (cached by the caller). */
  readonly runSession: (teamId: string, runId: string) => Promise<RunSession | undefined>;
}

export interface Placement {
  readonly parent: Context;
  readonly attributes: Attributes;
}

const FRESH: Placement = { parent: ROOT_CONTEXT, attributes: {} };

/**
 * Where `model_gateway.request` goes, decided **after** run attribution (contract in
 * `@kobe/protocol` tracing.ts, listener rule): the attributed run's trace, never the caller's.
 * The parent is the caller's span, remapped as the server remaps relayed sandbox spans, only when
 * the caller named this very run's trace; otherwise the run's root. A server call hangs under the
 * root. No run: a fresh trace. `session.id` / `user.id` come from the server-call claims or the
 * server's record of the run, never from the caller.
 */
export async function placeRequestSpan(
  tracing: GatewayTracing | undefined,
  headers: IncomingHttpHeaders,
  call: {
    readonly teamId: string;
    readonly runId: string | undefined;
    readonly serverCall: ServerCallClaims | undefined;
  },
): Promise<Placement> {
  const { runId, serverCall } = call;
  if (!telemetryState().enabled || runId === undefined) return FRESH;
  if (serverCall) {
    return {
      parent: runParentContext(runId),
      attributes: {
        ...idAttributes({ threadId: serverCall.thread_id }),
        ...sessionAttributes({ threadId: serverCall.thread_id, userId: serverCall.user_id }),
      },
    };
  }
  if (tracing === undefined) return { parent: runParentContext(runId), attributes: {} };
  const raw = headers.traceparent;
  const incoming = typeof raw === "string" ? parseTraceparent(raw) : undefined;
  const parent =
    incoming !== undefined && incoming.traceId === runTraceId(runId)
      ? runParentContext(runId, mapSandboxSpanId(tracing.spanKey, runId, incoming.parentSpanId))
      : runParentContext(runId);
  let session: RunSession | undefined;
  try {
    session = await tracing.runSession(call.teamId, runId);
  } catch {
    session = undefined; // tracing never fails a call
  }
  return {
    parent,
    attributes:
      session === undefined
        ? {}
        : { ...idAttributes({ threadId: session.threadId }), ...sessionAttributes(session) },
  };
}
