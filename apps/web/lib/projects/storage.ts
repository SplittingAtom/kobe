/**
 * Storage figures in words (Workspaces GV2; KOBE-581): bytes and objects, live and history. A
 * figure the server has not filled yet (null or absent) shows as "—".
 */
import { formatBytes } from "../files/format";

export const NOT_YET = "—";

export function bytesOrDash(value: number | null | undefined): string {
  return value == null ? NOT_YET : formatBytes(value);
}

export function countOrDash(value: number | null | undefined): string {
  return value == null ? NOT_YET : value.toLocaleString("en-US");
}

// ----------------------------------------------------------------------------- the storage view

/** `projects.history_keep` (GV3): every commit (default), the newest N, or those of the last N days. */
export type HistoryKeep =
  | { readonly mode: "all" }
  | { readonly mode: "commits"; readonly n: number }
  | { readonly mode: "days"; readonly n: number };

export interface StorageFigures {
  readonly liveBytes: number;
  readonly historyBytes: number;
  readonly liveObjects: number;
  readonly historyObjects: number;
}

/** `GET /v1/team/storage` (KOBE-579), mapped from its snake_case answer. */
export interface TeamStorage extends StorageFigures {
  readonly usedBytes: number;
  readonly usedObjects: number;
  /** The workspace's own limits; null = the site default (`default*`). */
  readonly quotaBytes: number | null;
  readonly maxObjects: number | null;
  readonly defaultQuotaBytes: number;
  readonly defaultMaxObjects: number;
  readonly historyKeep: HistoryKeep;
  readonly historyMaxCommits: number;
  readonly maxMountedPerMember: number;
  readonly scratchspaces: readonly {
    readonly userId: string;
    readonly liveBytes: number;
    readonly liveFiles: number;
    readonly objects: number;
  }[];
  readonly projects: readonly (StorageFigures & {
    readonly projectId: string;
    readonly slug: string;
    readonly name: string;
    readonly commits: number;
  })[];
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);

function historyKeepOf(v: unknown): HistoryKeep {
  const r = rec(v);
  if ((r.mode === "commits" || r.mode === "days") && num(r.n) > 0) {
    return { mode: r.mode, n: num(r.n) };
  }
  return { mode: "all" };
}

/**
 * The storage view from the server's snake_case keys (also accepts them camelized by the API
 * client); anything missing reads as 0, the documented defaults, or an empty list.
 */
export function teamStorageFromWire(wire: unknown): TeamStorage {
  const w = rec(wire);
  const pick = (snake: string, camel: string): unknown => w[snake] ?? w[camel];
  const figures = (r: Record<string, unknown>): StorageFigures => ({
    liveBytes: num(r.live_bytes ?? r.liveBytes),
    historyBytes: num(r.history_bytes ?? r.historyBytes),
    liveObjects: num(r.live_objects ?? r.liveObjects),
    historyObjects: num(r.history_objects ?? r.historyObjects),
  });
  return {
    ...figures(w),
    usedBytes: num(pick("used_bytes", "usedBytes")),
    usedObjects: num(pick("used_objects", "usedObjects")),
    quotaBytes: numOrNull(pick("quota_bytes", "quotaBytes")),
    maxObjects: numOrNull(pick("max_objects", "maxObjects")),
    defaultQuotaBytes: num(pick("default_quota_bytes", "defaultQuotaBytes")),
    defaultMaxObjects: num(pick("default_max_objects", "defaultMaxObjects")),
    historyKeep: historyKeepOf(pick("history_keep", "historyKeep")),
    historyMaxCommits: num(pick("history_max_commits", "historyMaxCommits"), 1000),
    maxMountedPerMember: num(pick("max_mounted_per_member", "maxMountedPerMember"), 20),
    scratchspaces: list(w.scratchspaces).map((s) => ({
      userId: String(s.user_id ?? s.userId ?? ""),
      liveBytes: num(s.live_bytes ?? s.liveBytes),
      liveFiles: num(s.live_files ?? s.liveFiles),
      objects: num(s.objects),
    })),
    projects: list(w.projects).map((p) => ({
      ...figures(p),
      projectId: String(p.project_id ?? p.projectId ?? ""),
      slug: String(p.slug ?? ""),
      name: String(p.name ?? ""),
      commits: num(p.commits),
    })),
  };
}

/** `PUT /v1/team/storage` body: only the settings that changed; `maxObjects: null` = site default. */
export interface StorageSettingsChange {
  readonly historyKeep?: HistoryKeep;
  readonly maxMountedPerMember?: number;
  readonly maxObjects?: number | null;
}

export function storageSettingsBody(change: StorageSettingsChange): Record<string, unknown> {
  return {
    ...(change.historyKeep === undefined ? {} : { history_keep: change.historyKeep }),
    ...(change.maxMountedPerMember === undefined
      ? {}
      : { max_mounted_per_member: change.maxMountedPerMember }),
    ...(change.maxObjects === undefined ? {} : { max_objects: change.maxObjects }),
  };
}

export function historyKeepText(keep: HistoryKeep, maxCommits: number): string {
  if (keep.mode === "all") return `Every commit (at most ${maxCommits} per project)`;
  if (keep.mode === "commits") return `The newest ${keep.n} commits per project`;
  return `Commits of the last ${keep.n} days`;
}
