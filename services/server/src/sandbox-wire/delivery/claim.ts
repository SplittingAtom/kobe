import { sql, withTeam, type KobeTx } from "@kobe/db";
import { CAPABILITY_RUN_TOKEN, type RunTokenGrant } from "@kobe/protocol";
import { markDelivered, type CommandRow } from "../commands.js";
import { mintRunToken } from "../run-token.js";
import { loadRun } from "../run-state.js";
import { slotOf } from "../slots.js";
import type { DeliveryEnv } from "./env.js";

/** A command this connection may send: the run's durable cursor and token for a start. */
export interface Claimed {
  readonly cursor: number;
  readonly runToken: RunTokenGrant | undefined;
  readonly startedAt: Date | null;
}

/**
 * Claims a stored command for delivery on this connection, in one transaction (KOBE-707: moved
 * out of delivery.ts): only the sandbox's current connection delivers; a start leases its run
 * (holding off a concurrent Stop) and mints its run token. "gone": expired or taken meanwhile;
 * "replaced": a newer connection exists; "run_not_active": the run ended or is not this member's.
 */
export function claimDelivery(
  env: DeliveryEnv,
  row: CommandRow,
  starts: boolean,
): Promise<Claimed | "gone" | "replaced" | "run_not_active"> {
  const { ctx, host } = env;
  const { teamId } = host.target;
  return withTeam(ctx.db, teamId, async (tx: KobeTx) => {
    if (!(await isCurrent(tx, env))) return "replaced" as const;
    // An eval sandbox (KOBE-325) takes only its own thread's commands (the slot already says so).
    const evalThreadId = host.target.evalThreadId;
    if (evalThreadId !== undefined && row.threadId !== evalThreadId) return "gone" as const;
    if (row.kind === "notebook.execute") {
      // KOBE-464: never run a cell for a run that ended meanwhile (Stop while the sandbox woke).
      // FOR SHARE holds off a concurrent Stop until this delivery is recorded.
      const res = await tx.execute<{ status: string }>(sql`
          SELECT status FROM runs WHERE team_id = ${teamId} AND id = ${row.runId ?? null}
             FOR SHARE`);
      const status = res.rows[0]?.status;
      if (status !== "running" && status !== "waiting_approval") {
        return "run_not_active" as const;
      }
    }
    if (starts) return claimStart(tx, env, row);
    return (await markDelivered(tx, teamId, row.id, host.id))
      ? { cursor: 0, runToken: undefined, startedAt: null }
      : ("gone" as const);
  });
}

/** Only the sandbox's current connection delivers (a replaced one may not have noticed yet). */
async function isCurrent(tx: KobeTx, env: DeliveryEnv): Promise<boolean> {
  const { host } = env;
  const { teamId, userId } = host.target;
  const evalThreadId = host.target.evalThreadId;
  const current = await tx.execute(
    evalThreadId === undefined
      ? sql`
        SELECT 1 FROM sandbox_connections
         WHERE team_id = ${teamId} AND user_id = ${userId}
           AND connection_id = ${host.id} AND closed_at IS NULL
         FOR SHARE`
      : sql`
        SELECT 1 FROM sandbox_eval_connections
         WHERE team_id = ${teamId} AND thread_id = ${evalThreadId} AND user_id = ${userId}
           AND connection_id = ${host.id} AND closed_at IS NULL
         FOR SHARE`,
  );
  return current.rowCount === 1;
}

/** A start: the run is still this member's and active, leased here, and its token minted. */
async function claimStart(
  tx: KobeTx,
  env: DeliveryEnv,
  row: CommandRow,
): Promise<Claimed | "gone" | "run_not_active"> {
  const { ctx, host } = env;
  const { teamId, userId } = host.target;
  // Holds off a concurrent Stop (KOBE-30) until the lease is recorded: a Stop that commits
  // first is seen here (not active → refused); one that commits later finds the lease and
  // its run.stop follows this run.start on the same connection.
  await tx.execute(sql`
          SELECT 1 FROM runs WHERE team_id = ${teamId} AND id = ${row.runId ?? null} FOR SHARE`);
  const run = await loadRun(tx, teamId, row.runId ?? "");
  if (
    !run ||
    run.ownerUserId !== userId ||
    run.threadId !== row.threadId ||
    (run.status !== "running" && run.status !== "waiting_approval")
  ) {
    return "run_not_active";
  }
  const leased = await tx.execute(sql`
          INSERT INTO sandbox_run_leases (team_id, run_id, user_id, slot, thread_id, sandbox_id)
          VALUES (${teamId}, ${row.runId}, ${userId}, ${slotOf(host.target)}, ${row.threadId},
                  ${host.sandboxId})
          ON CONFLICT (team_id, run_id) DO UPDATE
            SET sandbox_id = EXCLUDED.sandbox_id, leased_at = now()
            WHERE sandbox_run_leases.user_id = EXCLUDED.user_id
              AND sandbox_run_leases.thread_id = EXCLUDED.thread_id
              AND sandbox_run_leases.slot = EXCLUDED.slot
              AND (sandbox_run_leases.slot = ''
                OR sandbox_run_leases.sandbox_id = EXCLUDED.sandbox_id)`);
  if (leased.rowCount !== 1) return "run_not_active";
  if (!(await markDelivered(tx, teamId, row.id, host.id))) return "gone";
  // Only to agents that can hand it to Pi alone (KOBE-118); older ones keep the legacy path.
  // A compaction always has one (checked before delivery).
  const runToken =
    ctx.runTokenKey && host.hasCapability(CAPABILITY_RUN_TOKEN)
      ? await mintRunToken(tx, {
          key: ctx.runTokenKey,
          teamId,
          runId: row.runId ?? "",
          sandboxId: host.sandboxId,
          ttlSeconds: ctx.tuning.runTokenTtlSeconds,
        })
      : undefined;
  return { cursor: run.sandboxSeq, runToken, startedAt: run.startedAt };
}
