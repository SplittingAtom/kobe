import { withTeam } from "@kobe/db";
import type { HelloFrame } from "@kobe/protocol";
import { recordSpan, telemetryState } from "@kobe/telemetry";
import type { Logger } from "pino";
import { wakeStartedAt } from "../../sandbox-lifecycle/store.js";
import { agentHelloSpan } from "../../sandbox-lifecycle/timing.js";
import { completeCommand, orphanedDeliveries } from "../commands.js";
import type { WireContext } from "../context.js";
import { activeLeasedRuns } from "../run-state.js";
import type { CommandOutcome, SandboxTarget } from "../types.js";
import type { ConnectionPort } from "./port.js";

type LeasedRuns = Awaited<ReturnType<typeof activeLeasedRuns>>;
type Orphans = Awaited<ReturnType<typeof orphanedDeliveries>>;

/**
 * A hello's leased runs, from the database (KOBE-706: moved out of connection.ts): those the
 * sandbox offers on the same thread are kept (resumed), the others lost (interrupted), plus the
 * commands delivered on an earlier connection that never got their result.
 */
export function helloRuns(
  port: Pick<ConnectionPort, "ctx" | "target" | "sandboxId" | "connectionId">,
  hello: HelloFrame,
): Promise<{ listed: LeasedRuns; lost: LeasedRuns; orphans: Orphans }> {
  const { ctx, target, sandboxId, connectionId } = port;
  const offered = new Map(hello.runs.map((r) => [r.run_id, r]));
  return withTeam(ctx.db, target.teamId, async (tx) => {
    const active = await activeLeasedRuns(tx, target, sandboxId);
    // A compaction is never kept (KOBE-213): its `thread.compact` was issued on the old
    // connection, so no answer can arrive on this one; it ends (failed) and the agent, not
    // seeing it listed, aborts it. Its thread is released, its queue moves on.
    const resumable = (r: (typeof active)[number]) =>
      r.kind === "message" && offered.get(r.runId)?.thread_id === r.threadId;
    const keep = active.filter(resumable);
    const gone = active.filter((r) => !resumable(r));
    return {
      listed: keep,
      lost: gone,
      orphans: await orphanedDeliveries(tx, target, connectionId),
    };
  });
}

/** Commands delivered on an earlier connection never got their result (ids are per connection). */
export async function reconcileOrphans(
  ctx: WireContext,
  target: SandboxTarget,
  orphans: readonly { id: string; kind: string; runId: string | null }[],
  resumed: ReadonlySet<string>,
): Promise<void> {
  for (const o of orphans) {
    const outcome: CommandOutcome =
      o.kind === "run.start" && o.runId !== null && resumed.has(o.runId)
        ? { ok: true, data: { resumed: true } }
        : {
            ok: false,
            error: {
              code: o.kind === "run.start" ? "sandbox_lost" : "connection_lost",
              message: "the sandbox reconnected before answering",
            },
          };
    await withTeam(ctx.db, target.teamId, (tx) =>
      completeCommand(tx, ctx.bus, target.teamId, o.id, outcome),
    );
  }
}

/** KOBE-525: wake start → this hello, when the hello follows a wake (never blocks the hello). */
export function recordHelloTiming(
  ctx: WireContext,
  target: SandboxTarget,
  helloMs: number,
  log: Pick<Logger, "debug">,
): void {
  if (target.evalThreadId !== undefined || !telemetryState().enabled) return;
  wakeStartedAt(ctx.db, target)
    .then((startedAt) => {
      const span = agentHelloSpan(startedAt, helloMs);
      if (span) recordSpan(span.name, { startTime: span.startMs, endTime: span.endMs });
    })
    .catch((err: unknown) => log.debug({ err }, "hello timing unavailable"));
}
