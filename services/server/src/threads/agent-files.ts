import { sql, type KobeTx } from "@kobe/db";
import { THREAD_FILE_WRITE_TOOLS, THREAD_FILES_MAX, workspaceToolPath } from "@kobe/protocol";
import { isInternalPath } from "../workspace-files/paths.js";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";
import { currentEntries, type StoredEntry } from "../workspace-sync/store.js";

/**
 * The workspace files the agent wrote in a thread (KOBE-488, contract thread-files.ts): Pi
 * `write`/`edit` calls with a successful result, read from the thread's run events and, for runs
 * whose events were compacted (D18), from its mirrored entries; and accepted `propose_file_edit`
 * proposals (the synced file holds the proposed content). Only live files of the owner's synced
 * workspace are kept. Everything here is a tool's own record (untrusted): it only ever names
 * paths, which are then looked up in the owner's own workspace.
 */

/** One tool call or result, from either source, `at` in ms (orders first appearance). */
export type ToolRow =
  | {
      readonly kind: "call";
      readonly callId: string;
      readonly tool: string;
      readonly path: string | null;
      readonly at: number;
    }
  | {
      readonly kind: "result";
      readonly callId: string;
      readonly tool: string;
      readonly isError: boolean;
      readonly at: number;
    };

export interface PathAt {
  readonly path: string;
  readonly at: number;
}

/** Rows read per source at most (a thread with more writes lists its first ones). */
const ROWS_MAX = 10_000;
const WRITE_TOOLS: readonly string[] = THREAD_FILE_WRITE_TOOLS;

/** Paths of write/edit calls whose result succeeded, normalised, at the call's time. */
export function succeededWrites(rows: readonly ToolRow[]): PathAt[] {
  const okIds = new Set(
    rows.flatMap((r) =>
      r.kind === "result" && !r.isError && WRITE_TOOLS.includes(r.tool) ? [r.callId] : [],
    ),
  );
  return rows.flatMap((r): PathAt[] => {
    if (r.kind !== "call" || !WRITE_TOOLS.includes(r.tool) || !okIds.has(r.callId)) return [];
    const path = r.path === null ? undefined : workspaceToolPath(r.path);
    return path === undefined || isInternalPath(path) ? [] : [{ path, at: r.at }];
  });
}

/** Distinct paths in order of first appearance, at most `max`. */
export function orderedAgentFiles(items: readonly PathAt[], max: number): string[] {
  const sorted = [...items].sort((a, b) => a.at - b.at);
  return [...new Set(sorted.map((i) => i.path))].slice(0, max);
}

type EventRow = {
  readonly type: string;
  readonly call_id: string | null;
  readonly tool: string | null;
  readonly path: string | null;
  readonly is_error: boolean | null;
  readonly content_sha: string | null;
  readonly at_ms: string;
};

const toolNames = sql.join(
  WRITE_TOOLS.map((t) => sql`${t}`),
  sql`, `,
);

/** The thread's write/edit events and proposals (only the fields used; no file content). */
async function eventRows(tx: KobeTx, teamId: string, threadId: string) {
  const res = await tx.execute<EventRow>(sql`
    SELECT e.type, e.payload->>'tool_call_id' AS call_id, e.payload->>'tool' AS tool,
           CASE WHEN e.type = 'file.edit_proposed' THEN e.payload->>'path'
                ELSE e.payload->'input'->>'path' END AS path,
           (e.payload->>'is_error')::boolean AS is_error,
           CASE WHEN e.type = 'file.edit_proposed'
                THEN encode(sha256(convert_to(e.payload->>'content', 'UTF8')), 'hex') END
             AS content_sha,
           floor(extract(epoch FROM e.created_at) * 1000)::int8 AS at_ms
      FROM run_events e
      JOIN runs r ON r.team_id = e.team_id AND r.id = e.run_id
     WHERE e.team_id = ${teamId} AND r.team_id = ${teamId} AND r.thread_id = ${threadId}
       AND ((e.type IN ('tool.call', 'tool.result') AND e.payload->>'tool' IN (${toolNames}))
            OR e.type = 'file.edit_proposed')
     ORDER BY e.created_at, e.run_id, e.seq
     LIMIT ${ROWS_MAX}`);
  return res.rows;
}

type EntryRow = {
  readonly kind: "call" | "result";
  readonly call_id: string | null;
  readonly tool: string | null;
  readonly path: string | null;
  readonly is_error: string | null;
  readonly at_ms: string;
};

/** Write/edit calls and results in the thread's inline (not offloaded) message entries. */
async function entryRows(tx: KobeTx, teamId: string, threadId: string) {
  const res = await tx.execute<EntryRow>(sql`
    SELECT 'call' AS kind, p->>'id' AS call_id, p->>'name' AS tool,
           p->'arguments'->>'path' AS path, NULL AS is_error,
           floor(extract(epoch FROM te.created_at) * 1000)::int8 AS at_ms
      FROM thread_entries te
     CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(te.payload->'message'->'content') = 'array'
                  THEN te.payload->'message'->'content' ELSE '[]'::jsonb END) p
     WHERE te.team_id = ${teamId} AND te.thread_id = ${threadId} AND te.type = 'message'
       AND te.payload->'message'->>'role' = 'assistant'
       AND p->>'type' = 'toolCall' AND p->>'name' IN (${toolNames})
    UNION ALL
    SELECT 'result', te.payload->'message'->>'toolCallId', te.payload->'message'->>'toolName',
           NULL, te.payload->'message'->>'isError',
           floor(extract(epoch FROM te.created_at) * 1000)::int8
      FROM thread_entries te
     WHERE te.team_id = ${teamId} AND te.thread_id = ${threadId} AND te.type = 'message'
       AND te.payload->'message'->>'role' = 'toolResult'
       AND te.payload->'message'->>'toolName' IN (${toolNames})
     LIMIT ${ROWS_MAX}`);
  return res.rows;
}

function fromEvents(rows: readonly EventRow[]): ToolRow[] {
  return rows.flatMap((r): ToolRow[] => {
    if (r.call_id === null || r.tool === null) return [];
    const at = Number(r.at_ms);
    if (r.type === "tool.call") {
      return [{ kind: "call", callId: r.call_id, tool: r.tool, path: r.path, at }];
    }
    if (r.type === "tool.result") {
      return [
        { kind: "result", callId: r.call_id, tool: r.tool, isError: r.is_error !== false, at },
      ];
    }
    return [];
  });
}

function fromEntries(rows: readonly EntryRow[]): ToolRow[] {
  return rows.flatMap((r): ToolRow[] => {
    if (r.call_id === null || r.tool === null) return [];
    const at = Number(r.at_ms);
    return r.kind === "call"
      ? [{ kind: "call", callId: r.call_id, tool: r.tool, path: r.path, at }]
      : [{ kind: "result", callId: r.call_id, tool: r.tool, isError: r.is_error !== "false", at }];
  });
}

interface Proposal extends PathAt {
  readonly sha256: string;
}

function proposals(rows: readonly EventRow[]): Proposal[] {
  return rows.flatMap((r): Proposal[] => {
    if (r.type !== "file.edit_proposed" || r.path === null || r.content_sha === null) return [];
    const path = workspaceToolPath(r.path);
    return path === undefined ? [] : [{ path, sha256: r.content_sha, at: Number(r.at_ms) }];
  });
}

/**
 * The thread's agent-written files that are live in `owner`'s synced workspace, in order of first
 * appearance. The caller has checked that `owner` owns the thread (inside `withTeam`).
 */
export async function readAgentFiles(
  tx: KobeTx,
  owner: WorkspaceOwner,
  threadId: string,
): Promise<StoredEntry[]> {
  const events = await eventRows(tx, owner.teamId, threadId);
  const entries = await entryRows(tx, owner.teamId, threadId);
  const writes = [...succeededWrites(fromEvents(events)), ...succeededWrites(fromEntries(entries))];
  const proposed = proposals(events);
  const paths = [...new Set([...writes, ...proposed].map((p) => p.path))];
  const live = new Map(
    (await currentEntries(tx, owner, paths)).filter((e) => !e.deleted).map((e) => [e.path, e]),
  );
  const accepted = proposed.filter((p) => live.get(p.path)?.sha256 === p.sha256);
  const ordered = orderedAgentFiles(
    [...writes.filter((w) => live.has(w.path)), ...accepted],
    THREAD_FILES_MAX,
  );
  return ordered.flatMap((path) => {
    const entry = live.get(path);
    return entry ? [entry] : [];
  });
}
