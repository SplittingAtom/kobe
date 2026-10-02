import pg from "pg";
import type { KobeEvent } from "@kobe/protocol";
import type { TeamRole } from "@kobe/db";

/** Most events one read returns: what a stream holds in memory at a time. */
export const PAGE_MAX_ROWS = 50;
/** Byte budget per page (stored payload size); the first row is always included. */
export const PAGE_MAX_BYTES = 1024 * 1024;
/** Connections of the stream pool per process (separate from the API pool). */
export const STREAM_POOL_MAX = 4;

export interface RunState {
  readonly ended: boolean;
  readonly compacted: boolean;
  readonly lastSeq: number;
}

export interface WatchableRun extends RunState {
  readonly runId: string;
  readonly threadId: string;
  readonly ownerUserId: string;
}

export interface Page {
  /** null when the run no longer exists (thread purged). */
  readonly run: RunState | null;
  /** Events with seq > after, ascending and contiguous. Shared between streams: never mutate. */
  readonly events: readonly KobeEvent[];
}

export interface Access {
  readonly sessionLive: boolean;
  /** The user's role in the team, null when no longer a member. */
  readonly role: TeamRole | null;
  /** Owner of the run's thread, null when the run is gone. */
  readonly ownerUserId: string | null;
}

/** Database reads behind the event stream, on their own small pool. */
export interface StreamReader {
  loadRun(teamId: string, runId: string): Promise<WatchableRun | null>;
  /**
   * Events after `after` (≤ PAGE_MAX_ROWS rows, ≈ PAGE_MAX_BYTES) plus the run's state, from one
   * snapshot. Concurrent calls for the same (team, run, after) share one query, so the caught-up
   * watchers of a run cost one read per wake-up, not one per stream.
   */
  readPage(teamId: string, runId: string, after: number): Promise<Page>;
  /** Session, membership and thread owner in one statement (periodic revalidation). */
  access(input: {
    teamId: string;
    runId: string;
    userId: string;
    sessionId: string;
  }): Promise<Access>;
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAGE_SQL = `
  SELECT r.ended_at IS NOT NULL AS ended, r.events_compacted_at IS NOT NULL AS compacted,
         r.last_seq, p.seq, p.type, p.payload, p.created_at
    FROM runs r
    LEFT JOIN LATERAL (
      SELECT q.seq, q.type, q.payload, q.created_at
        FROM (SELECT e.seq, e.type, e.payload, e.created_at,
                     sum(pg_column_size(e.payload)) OVER (ORDER BY e.seq)
                       - pg_column_size(e.payload) AS bytes_before
                FROM run_events e
               WHERE e.team_id = r.team_id AND e.run_id = r.id AND e.seq > $3::bigint
               ORDER BY e.seq
               LIMIT ${PAGE_MAX_ROWS}) q
       WHERE q.bytes_before < ${PAGE_MAX_BYTES}
    ) p ON true
   WHERE r.team_id = $1 AND r.id = $2
   ORDER BY p.seq`;

const RUN_SQL = `
  SELECT r.thread_id, t.owner_user_id, r.ended_at IS NOT NULL AS ended,
         r.events_compacted_at IS NOT NULL AS compacted, r.last_seq
    FROM runs r
    JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
   WHERE r.team_id = $1 AND r.id = $2`;

const ACCESS_SQL = `
  SELECT EXISTS (SELECT 1 FROM sessions s WHERE s.id = $1 AND s.expires_at > now()) AS session_live,
         (SELECT m.role::text FROM team_members m WHERE m.team_id = $2 AND m.user_id = $3) AS role,
         (SELECT t.owner_user_id FROM runs r
            JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
           WHERE r.team_id = $2 AND r.id = $4) AS owner_user_id`;

interface PageRow {
  ended: boolean;
  compacted: boolean;
  last_seq: number;
  seq: number | null;
  type: string | null;
  payload: Record<string, unknown> | null;
  created_at: Date | null;
}

export function createStreamReader(options: {
  readonly connectionString: string;
  readonly max?: number;
}): StreamReader {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? STREAM_POOL_MAX,
    application_name: "kobe-event-stream",
    connectionTimeoutMillis: 10_000,
  });
  // An idle client's error (e.g. server restart) must not crash the process; the pool drops it.
  pool.on("error", () => undefined);
  const inFlight = new Map<string, Promise<Page>>();

  /**
   * One read-only transaction scoped to the team in three round trips: BEGIN + set_config as one
   * simple query (the team id is a validated UUID literal, never free text), the statement, COMMIT.
   * Same RLS context as withTeam(); the setting ends with the transaction.
   */
  async function inTeam<R extends pg.QueryResultRow>(
    teamId: string,
    text: string,
    values: readonly unknown[],
  ): Promise<R[]> {
    if (!UUID.test(teamId)) throw new Error("stream reader: team id must be a UUID");
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query(
        `BEGIN READ ONLY; SELECT set_config('kobe.team_id', '${teamId.toLowerCase()}', true)`,
      );
      const result = await client.query<R>(text, values as unknown[]);
      await client.query("COMMIT");
      return result.rows;
    } catch (err) {
      await client.query("ROLLBACK").catch((e: unknown) => {
        broken = e instanceof Error ? e : new Error(String(e));
      });
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async function readUncached(teamId: string, runId: string, after: number): Promise<Page> {
    const rows = await inTeam<PageRow>(teamId, PAGE_SQL, [teamId, runId, after]);
    const first = rows[0];
    if (!first) return { run: null, events: [] };
    const events: KobeEvent[] = [];
    for (const row of rows) {
      if (row.seq === null || row.type === null || row.created_at === null) continue;
      events.push({
        run_id: runId,
        seq: row.seq,
        ts: new Date(row.created_at).toISOString(),
        type: row.type,
        payload: row.payload ?? {},
      } as KobeEvent);
    }
    return {
      run: { ended: first.ended, compacted: first.compacted, lastSeq: first.last_seq },
      events,
    };
  }

  return {
    async loadRun(teamId, runId) {
      const [row] = await inTeam<{
        thread_id: string;
        owner_user_id: string;
        ended: boolean;
        compacted: boolean;
        last_seq: number;
      }>(teamId, RUN_SQL, [teamId, runId]);
      if (!row) return null;
      return {
        runId,
        threadId: row.thread_id,
        ownerUserId: row.owner_user_id,
        ended: row.ended,
        compacted: row.compacted,
        lastSeq: row.last_seq,
      };
    },
    readPage(teamId, runId, after) {
      const key = `${teamId}/${runId}/${after}`;
      let pending = inFlight.get(key);
      if (!pending) {
        pending = readUncached(teamId, runId, after).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      return pending;
    },
    async access({ teamId, runId, userId, sessionId }) {
      const [row] = await inTeam<{
        session_live: boolean;
        role: TeamRole | null;
        owner_user_id: string | null;
      }>(teamId, ACCESS_SQL, [sessionId, teamId, userId, runId]);
      return {
        sessionLive: row?.session_live ?? false,
        role: row?.role ?? null,
        ownerUserId: row?.owner_user_id ?? null,
      };
    },
    close: () => pool.end(),
  };
}
