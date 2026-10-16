import { z } from "zod";
import {
  and,
  eq,
  sql,
  threads,
  THREAD_PROJECT_MOVES_MAX,
  type KobeTx,
  type ThreadProjectMove,
} from "@kobe/db";
import { uuidSchema as wireUuidSchema, idSchema } from "@kobe/protocol";
import { loadAccess } from "../projects/access.js";

/**
 * A thread's moves between projects (CE19, KOBE-220), kept in `threads.project_moves` (newest
 * {@link THREAD_PROJECT_MOVES_MAX}) and shown as an inline marker on the first run that started
 * after them: from that run on the agent gets the new project's context (`run.start.project`,
 * read from the thread at every run start), so the marker says where its instructions changed.
 * Moves between two runs are one marker (first `from`, last `to`); a round trip shows none.
 */

const storedMoveSchema = z.object({
  at: z.iso.datetime({ offset: true }),
  from: wireUuidSchema.nullable(),
  to: wireUuidSchema.nullable(),
  runs: z.number().int().min(0).max(2_147_483_647),
});

/** The stored moves, oldest first; anything malformed is dropped (never trusted blindly). */
export function parseMoves(value: unknown): ThreadProjectMove[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((m) => {
    const parsed = storedMoveSchema.safeParse(m);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The moves with one more, the oldest dropped past the cap. */
export function withMove(
  moves: readonly ThreadProjectMove[],
  move: ThreadProjectMove,
): ThreadProjectMove[] {
  return [...moves, move].slice(-THREAD_PROJECT_MOVES_MAX);
}

/**
 * Reads the locked thread's moves, the time now (`clock_timestamp()`, taken under the row lock)
 * and how many of its message runs have started (where the next move's marker goes). Called
 * under the thread lock with no run queued or running, so the count can't change meanwhile.
 */
export async function movesOf(
  tx: KobeTx,
  teamId: string,
  threadId: string,
): Promise<{ moves: ThreadProjectMove[]; now: string; started: number }> {
  const [row] = await tx
    .select({
      moves: threads.projectMoves,
      now: sql<string>`clock_timestamp()`,
      started: sql<number>`(SELECT count(*)::int FROM runs r
        WHERE r.team_id = ${teamId}::uuid AND r.thread_id = ${threadId}::uuid
          AND r.kind = 'message' AND r.started_at IS NOT NULL)`,
    })
    .from(threads)
    .where(and(eq(threads.teamId, teamId), eq(threads.id, threadId)));
  return {
    moves: parseMoves(row?.moves),
    now: new Date(row?.now ?? Date.now()).toISOString(),
    started: Number(row?.started ?? 0),
  };
}

export const projectMarkerSchema = z.strictObject({
  /** The first run that started after the move(s): its context is the new project's. */
  run_id: wireUuidSchema,
  user_entry_id: idSchema.nullable(),
  parent_entry_id: idSchema.nullable(),
  /**
   * Where the thread was at the run before, and where it went: id and name while the viewer may
   * open the project; both null for no project, or with `*_hidden` for a project the viewer can't
   * open ("another project": its id is not sent).
   */
  from_project_id: wireUuidSchema.nullable(),
  from_project_name: z.string().nullable(),
  from_project_hidden: z.boolean(),
  to_project_id: wireUuidSchema.nullable(),
  to_project_name: z.string().nullable(),
  to_project_hidden: z.boolean(),
});
export type ProjectMarker = z.infer<typeof projectMarkerSchema>;

interface MoveRun {
  readonly move: ThreadProjectMove;
  /** The first message run that started after the move; null: none yet. */
  readonly runId: string | null;
  readonly userEntryId: string | null;
  readonly parentEntryId: string | null;
}

export interface MoveGroup {
  readonly runId: string;
  readonly userEntryId: string | null;
  readonly parentEntryId: string | null;
  readonly from: string | null;
  readonly to: string | null;
}

/**
 * Collapses the moves before each run into one change (first `from`, last `to`), oldest first;
 * moves no run has started after yet, and round trips that change nothing, are left out.
 */
export function groupMoves(rows: readonly MoveRun[]): MoveGroup[] {
  const byRun = new Map<string, MoveGroup>();
  for (const { move, runId, userEntryId, parentEntryId } of rows) {
    if (runId === null) continue;
    const seen = byRun.get(runId);
    const from = seen === undefined ? move.from : seen.from;
    byRun.set(runId, { runId, userEntryId, parentEntryId, from, to: move.to });
  }
  return [...byRun.values()].filter((g) => g.from !== g.to);
}

type Row = Record<string, unknown>;
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

type Side = { readonly id: string | null; readonly name: string | null; readonly hidden: boolean };

/** The project as the viewer may see it: id and name if they may open it (member or team admin). */
async function sideFor(
  tx: KobeTx,
  viewer: { teamId: string; userId: string },
  projectId: string | null,
  cache: Map<string, string | null>,
): Promise<Side> {
  if (projectId === null) return { id: null, name: null, hidden: false };
  if (!cache.has(projectId)) {
    const access = await loadAccess(tx, viewer, projectId);
    cache.set(projectId, access?.can.view ? access.project.name : null);
  }
  const name = cache.get(projectId) ?? null;
  return name === null
    ? { id: null, name: null, hidden: true }
    : { id: projectId, name, hidden: false };
}

/** The thread's project markers, oldest first (at most one per run). */
export async function projectMarkers(
  tx: KobeTx,
  viewer: { teamId: string; userId: string },
  threadId: string,
): Promise<ProjectMarker[]> {
  const res = await tx.execute<Row>(sql`
    SELECT m.ord, m.move, r.id AS run_id, r.user_entry_id, r.parent_entry_id
      FROM threads t
      CROSS JOIN LATERAL jsonb_array_elements(t.project_moves) WITH ORDINALITY AS m(move, ord)
      LEFT JOIN LATERAL (
        SELECT r.id, r.user_entry_id, r.parent_entry_id FROM runs r
         WHERE r.team_id = t.team_id AND r.thread_id = t.id AND r.kind = 'message'
           AND r.started_at IS NOT NULL
         ORDER BY r.started_at, r.id
         OFFSET (m.move ->> 'runs')::int LIMIT 1) r ON true
     WHERE t.team_id = ${viewer.teamId}::uuid AND t.id = ${threadId}::uuid
       AND jsonb_typeof(m.move -> 'runs') = 'number'
     ORDER BY m.ord`);
  const rows = res.rows.flatMap((r) => {
    const [move] = parseMoves([r.move]);
    return move
      ? [
          {
            move,
            runId: text(r.run_id),
            userEntryId: text(r.user_entry_id),
            parentEntryId: text(r.parent_entry_id),
          },
        ]
      : [];
  });
  const names = new Map<string, string | null>();
  const markers: ProjectMarker[] = [];
  for (const g of groupMoves(rows)) {
    const from = await sideFor(tx, viewer, g.from, names);
    const to = await sideFor(tx, viewer, g.to, names);
    markers.push({
      run_id: g.runId,
      user_entry_id: g.userEntryId,
      parent_entry_id: g.parentEntryId,
      from_project_id: from.id,
      from_project_name: from.name,
      from_project_hidden: from.hidden,
      to_project_id: to.id,
      to_project_name: to.name,
      to_project_hidden: to.hidden,
    });
  }
  return markers;
}
