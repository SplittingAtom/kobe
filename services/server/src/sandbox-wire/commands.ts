import { randomUUID } from "node:crypto";
import { sql, withTeam, type KobeDb, type KobeTx, type SandboxCommandKind } from "@kobe/db";
import type { SandboxBus } from "./bus.js";
import type { CommandOutcome, SandboxTarget } from "./types.js";

/** A command row as the holder delivers it. */
export interface CommandRow {
  readonly id: string;
  readonly kind: SandboxCommandKind;
  readonly threadId: string;
  readonly runId: string | null;
  readonly frame: Record<string, unknown>;
  readonly requesterReplica: string;
}

const outcomeJson = (outcome: CommandOutcome): Record<string, unknown> =>
  outcome.ok
    ? { ok: true, ...(outcome.data === undefined ? {} : { data: outcome.data }) }
    : { ok: false, error: outcome.error };

function parseOutcome(raw: unknown): CommandOutcome {
  const r = raw as { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
  if (r?.ok === true) return r.data === undefined ? { ok: true } : { ok: true, data: r.data };
  return {
    ok: false,
    error: {
      code: typeof r?.error?.code === "string" ? r.error.code : "internal",
      message: typeof r?.error?.message === "string" ? r.error.message : "command failed",
    },
  };
}

export interface LiveConnection {
  readonly connectionId: string;
  readonly replicaId: string;
}

/** The live connection of a sandbox: open and touched within `staleMs`. */
export async function liveConnection(
  tx: KobeTx,
  target: SandboxTarget,
  staleMs: number,
): Promise<LiveConnection | undefined> {
  const res = await tx.execute<{ connection_id: string; replica_id: string }>(sql`
    SELECT connection_id, replica_id FROM sandbox_connections
     WHERE team_id = ${target.teamId} AND user_id = ${target.userId}
       AND closed_at IS NULL
       AND last_seen_at > now() - make_interval(secs => ${staleMs / 1000})`);
  const row = res.rows[0];
  return row ? { connectionId: row.connection_id, replicaId: row.replica_id } : undefined;
}

/**
 * Requester side: stores the command and hints the holding replica in the same transaction (the
 * hint is delivered only on commit). Refuses a thread that is not the target user's: a command can
 * never be routed into another user's sandbox, whatever the caller passes.
 */
export async function enqueueCommand(
  db: KobeDb,
  bus: SandboxBus,
  input: {
    readonly target: SandboxTarget;
    readonly kind: SandboxCommandKind;
    readonly threadId: string;
    readonly runId?: string;
    readonly frame: Record<string, unknown>;
    readonly requesterReplica: string;
    readonly timeoutMs: number;
    readonly staleMs: number;
  },
): Promise<{ id: string; live?: LiveConnection } | { error: "thread_not_found" }> {
  const { target } = input;
  return withTeam(db, target.teamId, async (tx) => {
    const owner = await tx.execute<{ owner_user_id: string }>(sql`
      SELECT owner_user_id FROM threads WHERE team_id = ${target.teamId} AND id = ${input.threadId}`);
    if (owner.rows[0]?.owner_user_id !== target.userId)
      return { error: "thread_not_found" as const };
    const id = randomUUID();
    await tx.execute(sql`
      INSERT INTO sandbox_commands
        (team_id, id, user_id, thread_id, run_id, kind, frame, requester_replica, expires_at)
      VALUES (${target.teamId}, ${id}, ${target.userId}, ${input.threadId}, ${input.runId ?? null},
              ${input.kind}, ${JSON.stringify(input.frame)}::jsonb, ${input.requesterReplica},
              now() + make_interval(secs => ${input.timeoutMs / 1000}))`);
    const live = await liveConnection(tx, target, input.staleMs);
    if (live) await bus.notifyInTx(tx, { kind: "cmd", id: live.connectionId });
    return live ? { id, live } : { id };
  });
}

/** Requester side: the result if there is one (and deletes the row: it carries content). */
export async function takeResult(
  db: KobeDb,
  teamId: string,
  id: string,
): Promise<CommandOutcome | undefined> {
  return withTeam(db, teamId, async (tx) => {
    const res = await tx.execute<{ result: unknown }>(sql`
      DELETE FROM sandbox_commands
       WHERE team_id = ${teamId} AND id = ${id} AND status IN ('done', 'failed')
      RETURNING result`);
    return res.rows.length > 0 ? parseOutcome(res.rows[0]?.result) : undefined;
  });
}

/** Requester side: gives up on a command still open (deadline passed), then takes its result. */
export async function expireCommand(
  db: KobeDb,
  teamId: string,
  id: string,
): Promise<CommandOutcome> {
  await withTeam(db, teamId, (tx) =>
    tx.execute(sql`
      UPDATE sandbox_commands
         SET status = 'failed', completed_at = now(),
             result = ${JSON.stringify(outcomeJson({ ok: false, error: { code: "timeout", message: "the sandbox did not answer in time" } }))}::jsonb
       WHERE team_id = ${teamId} AND id = ${id} AND status IN ('pending', 'delivered')`),
  );
  return (
    (await takeResult(db, teamId, id)) ?? {
      ok: false,
      error: { code: "timeout", message: "the sandbox did not answer in time" },
    }
  );
}

/** Holder side: the oldest pending commands of a sandbox, in creation order. */
export async function pendingCommands(
  tx: KobeTx,
  target: SandboxTarget,
  limit: number,
): Promise<CommandRow[]> {
  const res = await tx.execute<{
    id: string;
    kind: SandboxCommandKind;
    thread_id: string;
    run_id: string | null;
    frame: Record<string, unknown>;
    requester_replica: string;
  }>(sql`
    SELECT id, kind, thread_id, run_id, frame, requester_replica FROM sandbox_commands
     WHERE team_id = ${target.teamId} AND user_id = ${target.userId} AND status = 'pending'
       AND expires_at > now()
     ORDER BY created_at, id
     LIMIT ${limit}`);
  return res.rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    threadId: r.thread_id,
    runId: r.run_id,
    frame: r.frame,
    requesterReplica: r.requester_replica,
  }));
}

/** Holder side: claims a pending command for this connection; false if someone else did. */
export async function markDelivered(
  tx: KobeTx,
  teamId: string,
  id: string,
  connectionId: string,
): Promise<boolean> {
  const res = await tx.execute(sql`
    UPDATE sandbox_commands
       SET status = 'delivered', connection_id = ${connectionId}, delivered_at = now()
     WHERE team_id = ${teamId} AND id = ${id} AND status = 'pending'`);
  return res.rowCount === 1;
}

/**
 * Holder side: records a command's outcome and hints its requester. `connectionId` (when given)
 * must match the delivering connection: a result is only valid on the connection it was issued on.
 */
export async function completeCommand(
  tx: KobeTx,
  bus: SandboxBus,
  teamId: string,
  id: string,
  outcome: CommandOutcome,
  connectionId?: string,
): Promise<boolean> {
  const res = await tx.execute(sql`
    UPDATE sandbox_commands
       SET status = ${outcome.ok ? "done" : "failed"}, completed_at = now(),
           result = ${JSON.stringify(outcomeJson(outcome))}::jsonb
     WHERE team_id = ${teamId} AND id = ${id}
       AND ${
         connectionId === undefined
           ? sql`status IN ('pending', 'delivered')`
           : sql`status = 'delivered' AND connection_id = ${connectionId}`
       }`);
  if (res.rowCount !== 1) return false;
  await bus.notifyInTx(tx, { kind: "res", id });
  return true;
}

/** Delivered commands of a sandbox whose connection is gone (reconciled at the next `hello`). */
export async function orphanedDeliveries(
  tx: KobeTx,
  target: SandboxTarget,
  currentConnectionId: string,
): Promise<{ id: string; kind: SandboxCommandKind; runId: string | null }[]> {
  const res = await tx.execute<{ id: string; kind: SandboxCommandKind; run_id: string | null }>(sql`
    SELECT id, kind, run_id FROM sandbox_commands
     WHERE team_id = ${target.teamId} AND user_id = ${target.userId}
       AND status = 'delivered' AND connection_id <> ${currentConnectionId}`);
  return res.rows.map((r) => ({ id: r.id, kind: r.kind, runId: r.run_id }));
}
