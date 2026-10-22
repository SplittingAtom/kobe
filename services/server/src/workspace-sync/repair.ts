import { sql, teams, withTeam, type KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import { workspaceBlobKey, workspacePrefix, type WorkspaceOwner } from "./keys.js";
import { markBlobLost } from "./lost.js";
import type { ObjectStore } from "./object-store.js";

/**
 * Repair sweep (KOBE-475): checks every live manifest row whose content lives in the workspace's
 * own prefix against object storage and marks what is missing lost, so the sandbox resends it
 * at its next push. An object counts as missing only when the prefix listing lacks it **and** a
 * read of it says "no such object" (never from a row or a listing alone). Nothing is deleted or
 * rewritten; `dryRun` only counts. Logs carry counts and ids, never paths or content.
 */
export interface RepairOptions {
  /** Object key prefix (KOBE_S3_PREFIX). */
  readonly prefix: string;
  readonly dryRun?: boolean;
  /** Only this team (all its workspaces, or `userId`'s). */
  readonly teamId?: string;
  readonly userId?: string;
  /** Stop after this many workspaces (the next run covers the rest; default: all). */
  readonly maxWorkspaces?: number;
  /** Pause after each storage listing page and confirming read, so a sweep never floods it. */
  readonly paceMs?: number;
}

/** Default pause between storage calls (one call at a time). */
export const REPAIR_PACE_MS = 20;

const pause = (ms: number) =>
  ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

export interface RepairResult {
  readonly workspaces: number;
  /** Distinct contents checked. */
  readonly checked: number;
  readonly missing: number;
  /** Newly marked lost by this run (already-marked ones are counted in `missing` only). */
  readonly marked: number;
}

const LIST_PAGE = 1000;

/** Every key under the workspace's prefix. */
async function storedKeys(
  objects: ObjectStore,
  prefix: string,
  paceMs: number,
): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await objects.list(prefix, {
      limit: LIST_PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const o of page.objects) keys.add(o.key);
    cursor = page.next;
    await pause(paceMs);
  } while (cursor !== undefined);
  return keys;
}

/** Confirms a key the listing lacked with a read: true only for "no such object". */
async function confirmedMissing(objects: ObjectStore, key: string): Promise<boolean> {
  const object = await objects.get(key);
  if (object === null) return true;
  object.body.destroy();
  return false;
}

async function repairWorkspace(
  db: KobeDb,
  objects: ObjectStore,
  owner: WorkspaceOwner,
  options: RepairOptions,
): Promise<Omit<RepairResult, "workspaces">> {
  const rows = await withTeam(db, owner.teamId, (tx) =>
    tx.execute<{ sha256: string; size: string; blob_key: string }>(sql`
      SELECT DISTINCT sha256, size, blob_key FROM workspace_files
       WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId} AND NOT deleted`),
  );
  const contents = new Map<string, number>();
  for (const r of rows.rows) {
    if (r.blob_key === workspaceBlobKey(options.prefix, owner, r.sha256)) {
      contents.set(r.sha256, Number(r.size));
    }
  }
  if (contents.size === 0) return { checked: 0, missing: 0, marked: 0 };
  const paceMs = options.paceMs ?? REPAIR_PACE_MS;
  const stored = await storedKeys(objects, workspacePrefix(options.prefix, owner), paceMs);
  const missing: [string, number][] = [];
  for (const [sha256, size] of contents) {
    const key = workspaceBlobKey(options.prefix, owner, sha256);
    if (stored.has(key)) continue;
    if (await confirmedMissing(objects, key)) missing.push([sha256, size]);
    await pause(paceMs);
  }
  let marked = 0;
  if (!options.dryRun && missing.length > 0) {
    marked = await withTeam(db, owner.teamId, async (tx) => {
      let n = 0;
      for (const [sha256, size] of missing) if (await markBlobLost(tx, owner, sha256, size)) n++;
      return n;
    });
  }
  return { checked: contents.size, missing: missing.length, marked };
}

async function ownersOf(db: KobeDb, options: RepairOptions): Promise<WorkspaceOwner[]> {
  const teamIds = options.teamId
    ? [options.teamId]
    : (await db.select({ id: teams.id }).from(teams)).map((t) => t.id);
  const owners: WorkspaceOwner[] = [];
  for (const teamId of teamIds) {
    const res = await withTeam(db, teamId, (tx) =>
      tx.execute<{ user_id: string }>(sql`
        SELECT user_id FROM workspace_sync WHERE team_id = ${teamId}
        ${options.userId ? sql`AND user_id = ${options.userId}` : sql``}
        ORDER BY user_id`),
    );
    for (const { user_id: userId } of res.rows) owners.push({ teamId, userId });
  }
  return owners;
}

/** The sweep over the chosen workspaces; one workspace's failure is logged and skipped. */
export async function repairWorkspaces(
  db: KobeDb,
  objects: ObjectStore,
  options: RepairOptions,
  log: Pick<Logger, "error" | "info">,
): Promise<RepairResult> {
  let total: RepairResult = { workspaces: 0, checked: 0, missing: 0, marked: 0 };
  const owners = await ownersOf(db, options);
  for (const owner of owners.slice(0, options.maxWorkspaces ?? owners.length)) {
    try {
      const r = await repairWorkspace(db, objects, owner, options);
      total = {
        workspaces: total.workspaces + 1,
        checked: total.checked + r.checked,
        missing: total.missing + r.missing,
        marked: total.marked + r.marked,
      };
      if (r.missing > 0) {
        log.info(
          { team_id: owner.teamId, user_id: owner.userId, ...r, dry_run: options.dryRun === true },
          "workspace content missing in storage",
        );
      }
    } catch (err) {
      log.error({ err, team_id: owner.teamId, user_id: owner.userId }, "workspace repair failed");
    }
  }
  log.info({ ...total, dry_run: options.dryRun === true }, "workspace repair sweep");
  return total;
}
