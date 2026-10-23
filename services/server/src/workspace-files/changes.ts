import { sql, type KobeTx } from "@kobe/db";
import { PROJECT_WORKSPACE_DIR, type WorkspaceFileChange } from "@kobe/protocol";
import type { WorkspaceOwner } from "../workspace-sync/keys.js";

/**
 * What the change stream (KOBE-496) reads: the manifest rows of the caller's own (team, user)
 * workspace at the requested paths, newer than a revision. `owner` is always the session's team
 * and user, and the statement names both (inside `withTeam`, so RLS holds it to the team too):
 * no input can reach another member's or another team's rows.
 *
 * Who made a revision follows from the row (no extra column): `sandbox` origin is the member's
 * agent; a server write under `projects/` is the project mount reconcile (`sync`), named after
 * the member who added that project file; any other server write is the member themselves (save,
 * upload, move, Edit as file, from any tab or device).
 */
type ChangeRow = {
  path: string;
  sha256: string | null;
  rev: string;
  deleted: boolean;
  origin: "sandbox" | "server";
  updated_at: Date | string;
  owner_name: string | null;
  project_adder: string | null;
};

const PROJECTS = `${PROJECT_WORKSPACE_DIR}/`;

export async function readFileChanges(
  tx: KobeTx,
  owner: WorkspaceOwner,
  paths: readonly string[],
  afterRev: number,
): Promise<WorkspaceFileChange[]> {
  if (paths.length === 0) return [];
  const res = await tx.execute<ChangeRow>(sql`
    SELECT f.path, f.sha256, f.rev, f.deleted, f.origin, f.updated_at,
           (SELECT u.name FROM users u WHERE u.id = f.user_id) AS owner_name,
           (SELECT u.name FROM project_files pf
              JOIN projects p ON p.team_id = pf.team_id AND p.id = pf.project_id
              JOIN users u ON u.id = pf.added_by
             WHERE f.origin = 'server' AND NOT f.deleted AND pf.team_id = f.team_id
               AND pf.sha256 = f.sha256
               AND ${PROJECTS} || p.slug || '/' || pf.path = f.path
             LIMIT 1) AS project_adder
      FROM workspace_files f
     WHERE f.team_id = ${owner.teamId} AND f.user_id = ${owner.userId}
       AND f.path IN ${[...paths]} AND f.rev > ${afterRev}
     ORDER BY f.rev`);
  return res.rows.map(toChange);
}

function toChange(row: ChangeRow): WorkspaceFileChange {
  return {
    path: row.path,
    sha256: row.deleted ? null : row.sha256,
    rev: Number(row.rev),
    actor: actorOf(row),
    at: new Date(row.updated_at).toISOString(),
  };
}

function actorOf(row: ChangeRow): WorkspaceFileChange["actor"] {
  if (row.origin === "sandbox") return { kind: "agent", name: null };
  if (row.path.startsWith(PROJECTS)) return { kind: "sync", name: row.project_adder };
  return { kind: "user", name: row.owner_name };
}

/** The state of every requested path: its row, or "never seen" for a path with none. */
export function snapshotOf(
  paths: readonly string[],
  rows: readonly WorkspaceFileChange[],
): WorkspaceFileChange[] {
  const byPath = new Map(rows.map((r) => [r.path, r]));
  return paths.map(
    (path) => byPath.get(path) ?? { path, sha256: null, rev: 0, actor: null, at: null },
  );
}
