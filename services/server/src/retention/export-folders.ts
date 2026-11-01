import { threadFolders, eq, withTeam, type KobeDb } from "@kobe/db";

/**
 * The team's folder paths by folder id for the export (KOBE-534, TF9): `"A/Sub-folder"`, by
 * names from the top level down. One read of the team's folders (at most 500); a chain longer
 * than the tree allows, or broken, is cut where it stops.
 */
export async function folderPaths(
  db: KobeDb,
  teamId: string,
): Promise<ReadonlyMap<string, string>> {
  const rows = await withTeam(db, teamId, (tx) =>
    tx
      .select({ id: threadFolders.id, parentId: threadFolders.parentId, name: threadFolders.name })
      .from(threadFolders)
      .where(eq(threadFolders.teamId, teamId)),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const paths = new Map<string, string>();
  for (const row of rows) {
    const names: string[] = [];
    for (let f: typeof row | undefined = row; f && names.length < 10;) {
      names.unshift(f.name);
      f = f.parentId === null ? undefined : byId.get(f.parentId);
    }
    paths.set(row.id, names.join("/"));
  }
  return paths;
}
