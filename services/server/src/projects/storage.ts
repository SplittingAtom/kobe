import { sql, type KobeTx } from "@kobe/db";
import { PROJECT_HISTORY_MAX_COMMITS } from "@kobe/protocol";
import { z } from "zod";
import { recordAudit } from "../audit/record.js";
import { objectLimit, objectsUsed, storageLimit, storageUsed } from "../uploads/quota.js";
import { DEFAULT_TEAM_MAX_OBJECTS } from "../uploads/settings.js";
import { MOUNTS_MAX_SETTING, mountLimit } from "./mounts.js";

/**
 * Storage governance of a workspace (KOBE-579, Workspaces GV2, GV3, MT3): the object budget beside
 * the byte quota, the history retention setting, and the storage view per workspace and project.
 * Objects are counted as the object store holds them: a scratchspace's distinct blobs
 * (`workspace_sync.blob_count`), each stored upload (`files`), each project's distinct objects,
 * head and history (`projects.live_objects + history_objects`).
 */

export { DEFAULT_TEAM_MAX_OBJECTS, objectLimit, objectsUsed };

/** `teams.settings` key of the history rule (GV3); absent = keep every commit. */
export const HISTORY_KEEP_SETTING = "projects.history_keep";

export const historyKeepSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("all") }),
  z.strictObject({
    mode: z.literal("commits"),
    n: z.number().int().min(1).max(PROJECT_HISTORY_MAX_COMMITS),
  }),
  z.strictObject({ mode: z.literal("days"), n: z.number().int().min(1).max(36_500) }),
]);
export type HistoryKeep = z.infer<typeof historyKeepSchema>;

/** `PUT /v1/team/storage`: any subset; `max_objects: null` returns to the site default. */
export const storageSettingsSchema = z
  .strictObject({
    history_keep: historyKeepSchema.optional(),
    max_mounted_per_member: z.number().int().min(1).max(1000).optional(),
    max_objects: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "nothing to change" });
export type StorageSettings = z.infer<typeof storageSettingsSchema>;

export interface TeamLimits {
  readonly quotaDefaultBytes: number;
  readonly maxObjectsDefault: number;
}

/**
 * Which limit `bytes` and `objects` more would pass (GV2), or undefined when they fit. The caller
 * holds the team storage lock (`lockTeamStorage`) and writes in the same transaction.
 */
export async function overLimit(
  tx: KobeTx,
  teamId: string,
  limits: TeamLimits,
  bytes: number,
  objects: number,
): Promise<"bytes" | "objects" | undefined> {
  if (bytes > 0) {
    const limit = await storageLimit(tx, teamId, limits.quotaDefaultBytes);
    if ((await storageUsed(tx, teamId)) + bytes > limit) return "bytes";
  }
  if (objects > 0) {
    const limit = await objectLimit(tx, teamId, limits.maxObjectsDefault);
    if ((await objectsUsed(tx, teamId)) + objects > limit) return "objects";
  }
  return undefined;
}

/** The team's history rule (GV3); a malformed value counts as `all`. */
export async function historyKeep(tx: KobeTx, teamId: string): Promise<HistoryKeep> {
  const res = await tx.execute<{ v: unknown }>(sql`
    SELECT settings -> ${HISTORY_KEEP_SETTING} AS v FROM teams WHERE id = ${teamId}`);
  const parsed = historyKeepSchema.safeParse(res.rows[0]?.v);
  return parsed.success ? parsed.data : { mode: "all" };
}

export interface StorageView {
  readonly used_bytes: number;
  readonly used_objects: number;
  readonly quota_bytes: number | null;
  readonly max_objects: number | null;
  readonly default_quota_bytes: number;
  readonly default_max_objects: number;
  readonly live_bytes: number;
  readonly history_bytes: number;
  readonly live_objects: number;
  readonly history_objects: number;
  readonly history_keep: HistoryKeep;
  readonly history_max_commits: number;
  readonly max_mounted_per_member: number;
  readonly scratchspaces: readonly {
    readonly user_id: string;
    readonly live_bytes: number;
    readonly live_files: number;
    readonly objects: number;
  }[];
  readonly projects: readonly {
    readonly project_id: string;
    readonly slug: string;
    readonly name: string;
    readonly commits: number;
    readonly live_bytes: number;
    readonly history_bytes: number;
    readonly live_objects: number;
    readonly history_objects: number;
  }[];
}

/** `GET /v1/team/storage` (team admins): totals, limits, settings, per scratchspace and project. */
export async function storageView(
  tx: KobeTx,
  teamId: string,
  limits: TeamLimits & { readonly historyMaxCommits: number },
): Promise<StorageView> {
  const quota = await tx.execute<{ max_bytes: string | null; max_objects: string | null }>(sql`
    SELECT max_bytes, max_objects FROM team_storage_quotas WHERE team_id = ${teamId}`);
  const spaces = await tx.execute<{
    user_id: string;
    live_bytes: string;
    live_files: number;
    blob_count: number;
  }>(sql`
    SELECT user_id, live_bytes, live_files, blob_count FROM workspace_sync
     WHERE team_id = ${teamId} ORDER BY live_bytes DESC, user_id`);
  const projects = await tx.execute<{
    id: string;
    slug: string;
    name: string;
    commits: string;
    live_bytes: string;
    history_bytes: string;
    live_objects: number;
    history_objects: number;
  }>(sql`
    SELECT p.id, p.slug, p.name, p.live_bytes, p.history_bytes, p.live_objects, p.history_objects,
           (SELECT count(*) FROM project_commits c
             WHERE c.team_id = p.team_id AND c.project_id = p.id) AS commits
      FROM projects p WHERE p.team_id = ${teamId}
     ORDER BY p.live_bytes + p.history_bytes DESC, p.slug`);
  const perProject = projects.rows.map((r) => ({
    project_id: r.id,
    slug: r.slug,
    name: r.name,
    commits: Number(r.commits),
    live_bytes: Number(r.live_bytes),
    history_bytes: Number(r.history_bytes),
    live_objects: Number(r.live_objects),
    history_objects: Number(r.history_objects),
  }));
  const sum = (k: "live_bytes" | "history_bytes" | "live_objects" | "history_objects") =>
    perProject.reduce((n, p) => n + p[k], 0);
  const own = quota.rows[0];
  return {
    used_bytes: await storageUsed(tx, teamId),
    used_objects: await objectsUsed(tx, teamId),
    quota_bytes: own?.max_bytes === null || own === undefined ? null : Number(own.max_bytes),
    max_objects: own?.max_objects === null || own === undefined ? null : Number(own.max_objects),
    default_quota_bytes: limits.quotaDefaultBytes,
    default_max_objects: limits.maxObjectsDefault,
    live_bytes: sum("live_bytes"),
    history_bytes: sum("history_bytes"),
    live_objects: sum("live_objects"),
    history_objects: sum("history_objects"),
    history_keep: await historyKeep(tx, teamId),
    history_max_commits: limits.historyMaxCommits,
    max_mounted_per_member: await mountLimit(tx, teamId),
    scratchspaces: spaces.rows.map((r) => ({
      user_id: r.user_id,
      live_bytes: Number(r.live_bytes),
      live_files: Number(r.live_files),
      objects: Number(r.blob_count),
    })),
    projects: perProject,
  };
}

const SETTINGS_OBJECT = sql`CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END`;

/** Writes the settings a team admin changed and audits the result (`project.storage_settings_changed`). */
export async function writeStorageSettings(
  tx: KobeTx,
  teamId: string,
  userId: string,
  body: StorageSettings,
): Promise<void> {
  if (body.history_keep !== undefined) {
    await tx.execute(sql`
      UPDATE teams SET settings = jsonb_set(${SETTINGS_OBJECT}, ${`{${HISTORY_KEEP_SETTING}}`}::text[],
             ${JSON.stringify(body.history_keep)}::jsonb, true)
       WHERE id = ${teamId}`);
  }
  if (body.max_mounted_per_member !== undefined) {
    await tx.execute(sql`
      UPDATE teams SET settings = jsonb_set(${SETTINGS_OBJECT}, ${`{${MOUNTS_MAX_SETTING}}`}::text[],
             ${JSON.stringify(body.max_mounted_per_member)}::jsonb, true)
       WHERE id = ${teamId}`);
  }
  if (body.max_objects !== undefined) {
    await tx.execute(sql`
      INSERT INTO team_storage_quotas (team_id, max_objects, updated_by)
      VALUES (${teamId}, ${body.max_objects}, ${userId})
      ON CONFLICT (team_id) DO UPDATE SET max_objects = EXCLUDED.max_objects,
        updated_by = EXCLUDED.updated_by, updated_at = now()`);
  }
  const quota = await tx.execute<{ max_objects: string | null }>(sql`
    SELECT max_objects FROM team_storage_quotas WHERE team_id = ${teamId}`);
  const maxObjects = quota.rows[0]?.max_objects;
  await recordAudit(tx, {
    action: "project.storage_settings_changed",
    actor: { kind: "user", id: userId },
    teamId,
    target: {
      historyKeep: await historyKeep(tx, teamId),
      maxMountedPerMember: await mountLimit(tx, teamId),
      maxObjects: maxObjects === null || maxObjects === undefined ? null : Number(maxObjects),
    },
  });
}
