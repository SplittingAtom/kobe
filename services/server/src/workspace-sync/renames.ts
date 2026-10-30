import { sql, type KobeTx } from "@kobe/db";
import type { WorkspaceOwner } from "./keys.js";

/**
 * Renames inside one sandbox commit (KOBE-516). The sandbox pushes an agent's `mv` as a put of
 * the new path and a delete of the old one, in the same commit, with the same content. Pairs are
 * found only when unambiguous both ways: the content's one new path (or, when the content came
 * more than once, the one with the old file's name), and that path's one candidate is this file.
 * Anything else names no move, and the old path's tab closes as for a deletion.
 */
export interface CommitFile {
  readonly path: string;
  readonly sha256: string;
}

export interface Rename {
  readonly from: string;
  readonly to: string;
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function unique(file: CommitFile, others: readonly CommitFile[]): CommitFile | undefined {
  const same = others.filter((o) => o.sha256 === file.sha256);
  if (same.length === 1) return same[0];
  const named = same.filter((o) => baseName(o.path) === baseName(file.path));
  return named.length === 1 ? named[0] : undefined;
}

/** Old paths gone and new paths created in one commit -> the renames among them. */
export function pairRenames(gone: readonly CommitFile[], created: readonly CommitFile[]): Rename[] {
  const out: Rename[] = [];
  for (const old of gone) {
    const target = unique(old, created);
    if (target && unique(target, gone) === old) out.push({ from: old.path, to: target.path });
  }
  return out;
}

/** The tombstones of `renames` name their new path (one statement; the caller's lock holds). */
export async function recordRenames(
  tx: KobeTx,
  owner: WorkspaceOwner,
  renames: readonly Rename[],
): Promise<void> {
  if (renames.length === 0) return;
  const list = (values: readonly string[]) =>
    sql`ARRAY[${sql.join(
      values.map((v) => sql`${v}`),
      sql`, `,
    )}]::text[]`;
  await tx.execute(sql`
    UPDATE workspace_files f SET moved_to = m.to_path
      FROM unnest(${list(renames.map((r) => r.from))}, ${list(renames.map((r) => r.to))})
           AS m(from_path, to_path)
     WHERE f.team_id = ${owner.teamId} AND f.user_id = ${owner.userId}
       AND f.path = m.from_path AND f.deleted`);
}
