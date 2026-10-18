import { z } from "zod";
import { sql, type KobeTx } from "@kobe/db";
import { idSchema, uuidSchema as wireUuidSchema } from "@kobe/protocol";

/**
 * Where a thread's agent version changed (D19, U8, KOBE-420): above the prompt of the first run
 * that ran on another version than the run before it. The version a run used is a fact of the
 * run: `runs.agent_version`, set from the thread's pin under the thread lock when the run starts
 * (`runs/lifecycle.ts`), so a switch racing a send is marked where the new version first ran.
 * Team-scoped by RLS (`withTeam`); runs without an agent, and runs compacted before the column
 * existed (migration 0129), are NULL and skipped. A run whose prompt never reached the tree passes
 * its marker to the next run that has one, so the change is never dropped.
 */

/** Newest message runs of the thread read for the markers (one more for the version before). */
export const MAX_AGENT_RUNS = 500;

export const agentMarkerSchema = z.strictObject({
  /** The first run on `to_version` (that has a prompt in the tree). */
  run_id: wireUuidSchema,
  user_entry_id: idSchema.nullable(),
  parent_entry_id: idSchema.nullable(),
  from_version: z.number().int().positive(),
  to_version: z.number().int().positive(),
});
export type AgentMarker = z.infer<typeof agentMarkerSchema>;

export interface StartedRun {
  readonly runId: string;
  /** The agent version the run started on (`runs.agent_version`); null: no agent, or unknown. */
  readonly version: number | null;
  readonly userEntryId: string | null;
  readonly parentEntryId: string | null;
}

/**
 * The changes between consecutive runs (oldest first) with a known version. A change whose run
 * has no prompt entry moves to the next run that has one; changes that meet there are one (first
 * `from`, last `to`), and a round trip shows none.
 */
export function agentChanges(runs: readonly StartedRun[]): AgentMarker[] {
  const markers: AgentMarker[] = [];
  let previous: number | null = null;
  let pendingFrom: number | null = null;
  for (const run of runs) {
    if (run.version === null) continue;
    if (previous !== null && run.version !== previous && pendingFrom === null)
      pendingFrom = previous;
    previous = run.version;
    if (pendingFrom === null || run.userEntryId === null) continue;
    if (pendingFrom !== run.version) {
      markers.push({
        run_id: run.runId,
        user_entry_id: run.userEntryId,
        parent_entry_id: run.parentEntryId,
        from_version: pendingFrom,
        to_version: run.version,
      });
    }
    pendingFrom = null;
  }
  return markers;
}

type Row = Record<string, unknown>;
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const version = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;

/** The thread's agent-version markers, oldest first: its newest message runs (`runs_thread_idx`). */
export async function agentMarkers(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<AgentMarker[]> {
  const res = await tx.execute<Row>(sql`
    SELECT r.id, r.user_entry_id, r.parent_entry_id, r.agent_version
      FROM runs r
     WHERE r.team_id = ${teamId}::uuid AND r.thread_id = ${threadId}::uuid
       AND r.kind = 'message' AND r.started_at IS NOT NULL
     ORDER BY r.started_at DESC, r.id DESC
     LIMIT ${MAX_AGENT_RUNS + 1}`);
  const runs = [...res.rows].reverse().map((r): StartedRun => ({
    runId: String(r.id),
    version: version(r.agent_version),
    userEntryId: text(r.user_entry_id),
    parentEntryId: text(r.parent_entry_id),
  }));
  return agentChanges(runs);
}
