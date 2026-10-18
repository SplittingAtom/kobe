import { z } from "zod";
import { sql, type KobeTx } from "@kobe/db";
import { idSchema, uuidSchema as wireUuidSchema } from "@kobe/protocol";

/**
 * A thread's switches to another version of its agent (D19, U8, KOBE-420), shown as an inline
 * marker on the first message run that started after them: from that run on the agent works with
 * the new version (the pin is read at every run start). The switch itself is the audit event
 * `thread.agent_switched` (`switchAgentVersion`), so no thread column holds them. Switches between
 * two runs are one marker (first `from`, last `to`); a round trip shows none.
 */

/** Most switches one thread's markers read (newest kept); a thread rarely has more than a few. */
export const MAX_AGENT_SWITCHES = 50;

export const agentMarkerSchema = z.strictObject({
  /** The first message run that started after the switch(es): it ran on `to_version`. */
  run_id: wireUuidSchema,
  user_entry_id: idSchema.nullable(),
  parent_entry_id: idSchema.nullable(),
  from_version: z.number().int().positive(),
  to_version: z.number().int().positive(),
});
export type AgentMarker = z.infer<typeof agentMarkerSchema>;

export interface AgentSwitchRun {
  readonly fromVersion: number;
  readonly toVersion: number;
  /** The first message run that started after the switch; null: none yet. */
  readonly runId: string | null;
  readonly userEntryId: string | null;
  readonly parentEntryId: string | null;
}

/**
 * Collapses the switches before each run into one change (first `from`, last `to`), oldest first
 * (`rows` oldest first); switches no run has started after yet, and round trips, are left out.
 */
export function groupAgentSwitches(rows: readonly AgentSwitchRun[]): AgentMarker[] {
  const byRun = new Map<string, AgentMarker>();
  for (const { fromVersion, toVersion, runId, userEntryId, parentEntryId } of rows) {
    if (runId === null) continue;
    const seen = byRun.get(runId);
    byRun.set(runId, {
      run_id: runId,
      user_entry_id: userEntryId,
      parent_entry_id: parentEntryId,
      from_version: seen === undefined ? fromVersion : seen.from_version,
      to_version: toVersion,
    });
  }
  return [...byRun.values()].filter((m) => m.from_version !== m.to_version);
}

type Row = Record<string, unknown>;
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const version = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;

/**
 * The thread's agent-version markers, oldest first (at most one per run). Reads the newest
 * {@link MAX_AGENT_SWITCHES} switch events of the team (`audit_log_action_seq_idx`), each with the
 * first message run that started after it (`runs_thread_idx`).
 */
export async function agentMarkers(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<AgentMarker[]> {
  const res = await tx.execute<Row>(sql`
    SELECT a.seq, a.target, r.id AS run_id, r.user_entry_id, r.parent_entry_id
      FROM audit_log a
      LEFT JOIN LATERAL (
        SELECT r.id, r.user_entry_id, r.parent_entry_id FROM runs r
         WHERE r.team_id = ${teamId}::uuid AND r.thread_id = ${threadId}::uuid
           AND r.kind = 'message' AND r.started_at IS NOT NULL AND r.started_at > a.at
         ORDER BY r.started_at, r.id
         LIMIT 1) r ON true
     WHERE a.action = 'thread.agent_switched' AND a.team_id = ${teamId}::uuid
       AND a.target ->> 'threadId' = ${threadId}
     ORDER BY a.seq DESC
     LIMIT ${MAX_AGENT_SWITCHES}`);
  const rows = [...res.rows].reverse().flatMap((r): AgentSwitchRun[] => {
    const target = (r.target ?? {}) as Row;
    const fromVersion = version(target.fromVersion);
    const toVersion = version(target.toVersion);
    if (fromVersion === null || toVersion === null) return [];
    return [
      {
        fromVersion,
        toVersion,
        runId: text(r.run_id),
        userEntryId: text(r.user_entry_id),
        parentEntryId: text(r.parent_entry_id),
      },
    ];
  });
  return groupAgentSwitches(rows);
}
