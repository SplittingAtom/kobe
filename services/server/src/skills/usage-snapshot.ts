import {
  scanTeams,
  sql,
  type KobeDb,
  type KobeTx,
  type RunSkillRef,
  type RunSkillUse,
} from "@kobe/db";
import { pickCatalogVersion, type CatalogVersion } from "../resolver/catalog-pins.js";

/**
 * The nightly usage aggregates of catalog skills (KOBE-339, SK26): for one fixed window, the last
 * {@link USAGE_WINDOW_DAYS} finished UTC days (ending at the start of the snapshot's UTC day), each
 * team's contribution per catalog skill: whether it installed the skill and which version that
 * install runs, whether it opted out of it (a Default), and per version the runs that used it, the
 * members whose runs did, and the thumbs on those runs' answers (KOBE-275).
 *
 * It holds team ids and user ids only to apply the minimum-count rule (`usage-views.ts`); nothing
 * here is ever returned as is. Each team is read under its own RLS (`scanTeams`). The Registry
 * team (re-runs, SK21), test chats and eval threads don't count. Computed once per UTC day per
 * replica (the nightly job warms it); every read on that day sees the same numbers, so two reads
 * can't be differenced within a day, and the window never moves within a day (ac-4).
 */
export const USAGE_WINDOW_DAYS = 30;

/** One team's part in one catalog skill. Versions by semver ("" when a run recorded none). */
export interface TeamUse {
  installed: boolean;
  /** The version the team's install runs now (null: none can run, or not installed). */
  running: string | null;
  optedOut: boolean;
  readonly runs: Map<string, number>;
  readonly members: Map<string, Set<string>>;
  readonly up: Map<string, number>;
  readonly down: Map<string, number>;
  readonly raters: Map<string, Set<string>>;
}

export interface UsageSnapshot {
  /** The UTC day it was computed for (YYYY-MM-DD): the window ends at its start. */
  readonly day: string;
  readonly from: string;
  readonly to: string;
  readonly computedAt: string;
  /** skill id → team id → its part. */
  readonly skills: ReadonlyMap<string, ReadonlyMap<string, TeamUse>>;
  /** user id → the teams they belong to (to leave the viewer's own teams out of the rule). */
  readonly memberships: ReadonlyMap<string, ReadonlySet<string>>;
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function usageWindow(day: string): { from: string; to: string } {
  const to = new Date(`${day}T00:00:00.000Z`);
  const from = new Date(to.getTime() - USAGE_WINDOW_DAYS * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

const emptyUse = (): TeamUse => ({
  installed: false,
  running: null,
  optedOut: false,
  runs: new Map(),
  members: new Map(),
  up: new Map(),
  down: new Map(),
  raters: new Map(),
});

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const add = (m: Map<string, Set<string>>, k: string, v: string) => {
  const s = m.get(k) ?? new Set<string>();
  s.add(v);
  m.set(k, s);
};

/** The catalog skills (by id) a run used, each with the version it loaded. */
function catalogUses(
  used: readonly RunSkillUse[],
  refs: readonly RunSkillRef[],
  idByName: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const u of used) {
    if (u.source !== "catalog") continue;
    const id = idByName.get(u.name);
    if (!id || out.has(id)) continue;
    const ref = refs.find((r) => r.source === "catalog" && r.name === u.name);
    out.set(id, ref?.semver ?? "");
  }
  return out;
}

type Catalog = {
  readonly idByName: ReadonlyMap<string, string>;
  readonly versions: ReadonlyMap<string, CatalogVersion[]>;
};

async function readCatalog(db: KobeDb): Promise<Catalog> {
  const skills = await db.execute<{ id: string; name: string }>(
    sql`SELECT id, name FROM registry_skills`,
  );
  const vs = await db.execute<{
    id: string;
    skill_id: string;
    semver: string;
    seq: number;
    state: string;
    suspended: boolean;
    runtime_hash: string;
    package_hash: string;
  }>(sql`
    SELECT id, skill_id, semver, seq, state::text AS state, suspended_at IS NOT NULL AS suspended,
      runtime_hash, package_hash
      FROM registry_versions
     WHERE state::text IN ('approved', 'deprecated', 'withdrawn', 'revoked')`);
  const versions = new Map<string, CatalogVersion[]>();
  for (const v of vs.rows) {
    const list = versions.get(v.skill_id) ?? [];
    list.push({
      id: v.id,
      semver: v.semver,
      seq: Number(v.seq),
      state: v.state,
      suspended: v.suspended,
      runtimeHash: v.runtime_hash,
      packageHash: v.package_hash,
    });
    versions.set(v.skill_id, list);
  }
  return { idByName: new Map(skills.rows.map((s) => [s.name, s.id])), versions };
}

type UseRow = { user_id: string; used: RunSkillUse[]; refs: RunSkillRef[] };

/** One team's part, read inside its own RLS context. */
async function teamPart(
  tx: KobeTx,
  teamId: string,
  window: { from: string; to: string },
  catalog: Catalog,
): Promise<{ uses: Map<string, TeamUse>; members: string[] }> {
  const uses = new Map<string, TeamUse>();
  const of = (skillId: string) => {
    const u = uses.get(skillId) ?? emptyUse();
    uses.set(skillId, u);
    return u;
  };
  const installs = await tx.execute<{ skill_id: string; version_id: string; pin_mode: string }>(
    sql`SELECT skill_id, version_id, pin_mode::text AS pin_mode
          FROM team_skill_installs WHERE team_id = ${teamId}`,
  );
  for (const i of installs.rows) {
    const u = of(i.skill_id);
    u.installed = true;
    const pick = pickCatalogVersion(catalog.versions.get(i.skill_id) ?? [], {
      pinMode: i.pin_mode as "pinned" | "within_major" | "latest",
      versionId: i.version_id,
    });
    u.running = pick.ok ? pick.version.semver : null;
  }
  const optouts = await tx.execute<{ skill_id: string }>(
    sql`SELECT skill_id FROM team_skill_optouts WHERE team_id = ${teamId}`,
  );
  for (const o of optouts.rows) of(o.skill_id).optedOut = true;
  // Runs of the window that used a skill (`runs_skill_uses_idx`), members' own threads only.
  const runs = await tx.execute<UseRow>(sql`
    SELECT t.owner_user_id AS user_id, r.skills_used AS used, r.skill_refs AS refs
      FROM runs r JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
     WHERE r.team_id = ${teamId} AND t.team_id = ${teamId}
       AND jsonb_array_length(r.skills_used) > 0
       AND r.created_at >= ${window.from}::timestamptz AND r.created_at < ${window.to}::timestamptz
       AND NOT t.skill_test AND NOT t.skill_eval`);
  for (const r of runs.rows)
    for (const [skillId, semver] of catalogUses(r.used, r.refs, catalog.idByName)) {
      const u = of(skillId);
      bump(u.runs, semver);
      add(u.members, semver, r.user_id);
    }
  // Ratings of the window on answers of runs that used a skill.
  const rated = await tx.execute<UseRow & { rating: string }>(sql`
    SELECT f.user_id, f.rating, r.skills_used AS used, r.skill_refs AS refs
      FROM answer_feedback f
      JOIN runs r ON r.team_id = f.team_id AND r.id = f.run_id
      JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
     WHERE f.team_id = ${teamId} AND r.team_id = ${teamId} AND t.team_id = ${teamId}
       AND jsonb_array_length(r.skills_used) > 0
       AND f.updated_at >= ${window.from}::timestamptz AND f.updated_at < ${window.to}::timestamptz
       AND NOT t.skill_test AND NOT t.skill_eval`);
  for (const r of rated.rows)
    for (const [skillId, semver] of catalogUses(r.used, r.refs, catalog.idByName)) {
      const u = of(skillId);
      bump(r.rating === "up" ? u.up : u.down, semver);
      add(u.raters, semver, r.user_id);
    }
  const members = await tx.execute<{ user_id: string }>(
    sql`SELECT user_id FROM team_members WHERE team_id = ${teamId}`,
  );
  return { uses, members: members.rows.map((m) => m.user_id) };
}

export async function computeUsageSnapshot(db: KobeDb, now: Date): Promise<UsageSnapshot> {
  const day = utcDay(now);
  const window = usageWindow(day);
  const catalog = await readCatalog(db);
  const registry = await db.execute<{ id: string }>(sql`SELECT id FROM teams WHERE registry`);
  const skip = new Set(registry.rows.map((r) => r.id));
  const parts = await scanTeams(db, "skillUsageSnapshot", async (tx, team) =>
    skip.has(team.id)
      ? undefined
      : { teamId: team.id, ...(await teamPart(tx, team.id, window, catalog)) },
  );
  const skills = new Map<string, Map<string, TeamUse>>();
  const memberships = new Map<string, Set<string>>();
  for (const p of parts) {
    for (const [skillId, use] of p.uses) {
      const teams = skills.get(skillId) ?? new Map<string, TeamUse>();
      teams.set(p.teamId, use);
      skills.set(skillId, teams);
    }
    for (const userId of p.members) add(memberships, userId, p.teamId);
  }
  return { day, ...window, computedAt: now.toISOString(), skills, memberships };
}

/**
 * The day's snapshot, computed once per UTC day per replica (single flight). The nightly job
 * calls it just after midnight UTC; a read before that computes it then.
 */
let current: { day: string; snapshot: Promise<UsageSnapshot> } | null = null;

export function usageSnapshot(db: KobeDb, now: Date = new Date()): Promise<UsageSnapshot> {
  const day = utcDay(now);
  if (current?.day !== day) {
    const snapshot = computeUsageSnapshot(db, now);
    current = { day, snapshot };
    // A failed computation is retried by the next read.
    snapshot.catch(() => {
      if (current?.snapshot === snapshot) current = null;
    });
  }
  return current.snapshot;
}

/** Tests: drop the cached snapshot. */
export function forgetUsageSnapshot(): void {
  current = null;
}

/** Minutes after midnight UTC the nightly job computes the new day's snapshot. */
const NIGHTLY_OFFSET_MS = 5 * 60_000;

/** Milliseconds from `now` to the next nightly run (00:05 UTC). */
export function msToNextNightly(now: Date): number {
  const next = new Date(`${utcDay(now)}T00:00:00.000Z`).getTime() + NIGHTLY_OFFSET_MS;
  const at = next > now.getTime() ? next : next + 86_400_000;
  return at - now.getTime();
}

/**
 * The nightly refresh (ac-1): computes the snapshot at start, then just after each midnight UTC.
 * Reads only; a failure is logged and the next read retries. Returns how to stop it.
 */
export function startUsageSnapshots(deps: {
  readonly db: KobeDb;
  readonly log: { error(obj: object, msg: string): void };
}): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const run = () => {
    usageSnapshot(deps.db).catch((err: unknown) =>
      deps.log.error({ err }, "skill usage snapshot failed"),
    );
    if (!stopped) timer = setTimeout(run, msToNextNightly(new Date()));
    timer?.unref();
  };
  run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
