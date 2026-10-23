import { sql, type KobeTx } from "@kobe/db";
import {
  PROJECT_WORKSPACE_DIR,
  WORKSPACE_CHANGE_ACTOR_NAME_MAX as ACTOR_NAME_MAX,
  type WorkspaceFileChange,
} from "@kobe/protocol";
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
           -- projects/<slug>/<path>: by the unique (team, slug) and (team, project, path) indexes.
           (SELECT u.name FROM projects p
              JOIN project_files pf ON pf.team_id = p.team_id AND pf.project_id = p.id
               AND pf.path = substr(f.path, char_length(${PROJECTS} || p.slug || '/') + 1)
              JOIN users u ON u.id = pf.added_by
             WHERE f.origin = 'server' AND NOT f.deleted AND f.path LIKE ${`${PROJECTS}%`}
               AND p.team_id = f.team_id AND p.slug = split_part(f.path, '/', 2)
               AND pf.sha256 = f.sha256
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
  if (row.path.startsWith(PROJECTS)) return { kind: "sync", name: actorName(row.project_adder) };
  return { kind: "user", name: actorName(row.owner_name) };
}

/**
 * A display name as the contract allows it (1 to {@link ACTOR_NAME_MAX} characters, no control
 * characters), or null: `users.name` is unbounded text, and a change must never fail the
 * client's schema because of a name.
 */
export function actorName(raw: string | null): string | null {
  if (raw === null) return null;
  // eslint-disable-next-line no-control-regex
  let name = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (name.length > ACTOR_NAME_MAX) {
    name = name.slice(0, ACTOR_NAME_MAX);
    // Never end on half a surrogate pair.
    if (/[\ud800-\udbff]$/.test(name)) name = name.slice(0, -1);
    name = name.trimEnd();
  }
  return name === "" ? null : name;
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
