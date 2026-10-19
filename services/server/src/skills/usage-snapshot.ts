import {
  listMemberships,
  sql,
  withTeam,
  type KobeDatabase,
  type KobeDb,
  type KobeTx,
  type RunSkillRef,
  type RunSkillUse,
} from "@kobe/db";
import { pickCatalogVersion, type CatalogVersion } from "../resolver/catalog-pins.js";

/**
 * The usage aggregates of catalog skills (KOBE-339, SK26), per **closed window**: windows are
 * fixed, non-overlapping {@link USAGE_WINDOW_DAYS}-day periods counted from the Unix epoch (UTC,
 * review M2). Once a window closes, one replica, under an advisory lock, computes each team's
 * contribution per catalog skill and stores it in `skill_usage_snapshots` (review M1); every
 * replica serves the last closed window's row, so a window's numbers never change after it
 * closes and never differ between replicas or restarts. No two answers cover overlapping windows,
 * so nothing can be differenced day by day.
 *
 * A team's contribution: whether it installed the skill and which version its install ran when
 * the window was computed, a Default opt-out, and per version the runs that read the skill, the
 * members whose runs did (the thread's owner: runs record no starter, review L5) and the thumbs on
 * those runs' answers. Team and user ids stay on the server (the minimum-count rule needs them,
 * `usage-views.ts`); nothing here is returned as is. Each team is read in its own transaction
 * under its RLS (review L3); the Registry team, test chats and eval threads don't count.
 */
export const USAGE_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const WINDOW_MS = USAGE_WINDOW_DAYS * DAY_MS;
const LOCK = "kobe.skills.usage-snapshot";

/** One team's part in one catalog skill. Versions by semver ("" when a run recorded none). */
export interface TeamUse {
  installed: boolean;
  /** The version the team's install ran (null: none could run, or not installed). */
  running: string | null;
  optedOut: boolean;
  readonly runs: Map<string, number>;
  readonly members: Map<string, Set<string>>;
  readonly up: Map<string, number>;
  readonly down: Map<string, number>;
  readonly raters: Map<string, Set<string>>;
}

export interface UsageSnapshot {
  readonly from: string;
  readonly to: string;
  readonly computedAt: string;
  /** skill id → team id → its part. */
  readonly skills: ReadonlyMap<string, ReadonlyMap<string, TeamUse>>;
}

export interface UsageWindow {
  readonly from: string;
  readonly to: string;
}

/** The last window that closed at or before `now`. */
export function closedWindow(now: Date): UsageWindow {
  const end = Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS;
  return {
    from: new Date(end - WINDOW_MS).toISOString(),
    to: new Date(end).toISOString(),
  };
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
  window: UsageWindow,
  catalog: Catalog,
): Promise<Map<string, TeamUse>> {
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
  // Ratings of the window's runs that used a skill (the run's window, so a rating changed later
  // can't move a closed window: it was computed once).
  const rated = await tx.execute<UseRow & { rating: string }>(sql`
    SELECT f.user_id, f.rating, r.skills_used AS used, r.skill_refs AS refs
      FROM answer_feedback f
      JOIN runs r ON r.team_id = f.team_id AND r.id = f.run_id
      JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
     WHERE f.team_id = ${teamId} AND r.team_id = ${teamId} AND t.team_id = ${teamId}
       AND jsonb_array_length(r.skills_used) > 0
       AND r.created_at >= ${window.from}::timestamptz AND r.created_at < ${window.to}::timestamptz
       AND NOT t.skill_test AND NOT t.skill_eval`);
  for (const r of rated.rows)
    for (const [skillId, semver] of catalogUses(r.used, r.refs, catalog.idByName)) {
      const u = of(skillId);
      bump(r.rating === "up" ? u.up : u.down, semver);
      add(u.raters, semver, r.user_id);
    }
  return uses;
}

export async function computeUsageSnapshot(
  db: KobeDb,
  window: UsageWindow,
  now: Date,
): Promise<UsageSnapshot> {
  const catalog = await readCatalog(db);
  const teams = await db.execute<{ id: string }>(
    sql`SELECT id FROM teams WHERE NOT registry ORDER BY id`,
  );
  const skills = new Map<string, Map<string, TeamUse>>();
  for (const team of teams.rows) {
    const uses = await withTeam(db, team.id, (tx) => teamPart(tx, team.id, window, catalog));
    for (const [skillId, use] of uses) {
      const per = skills.get(skillId) ?? new Map<string, TeamUse>();
      per.set(team.id, use);
      skills.set(skillId, per);
    }
  }
  return { ...window, computedAt: now.toISOString(), skills };
}

// --- storage: the payload is plain JSON of the maps ------------------------------------------

type StoredUse = {
  i: boolean;
  r: string | null;
  o: boolean;
  runs: Record<string, number>;
  members: Record<string, string[]>;
  up: Record<string, number>;
  down: Record<string, number>;
  raters: Record<string, string[]>;
};
type Payload = { skills: Record<string, Record<string, StoredUse>> };

const toObj = <V, W>(m: ReadonlyMap<string, V>, f: (v: V) => W) =>
  Object.fromEntries([...m].map(([k, v]) => [k, f(v)]));

export function toPayload(s: UsageSnapshot): Payload {
  return {
    skills: toObj(s.skills, (teams) =>
      toObj(teams, (u) => ({
        i: u.installed,
        r: u.running,
        o: u.optedOut,
        runs: toObj(u.runs, (n) => n),
        members: toObj(u.members, (set) => [...set]),
        up: toObj(u.up, (n) => n),
        down: toObj(u.down, (n) => n),
        raters: toObj(u.raters, (set) => [...set]),
      })),
    ),
  };
}

const numMap = (o: Record<string, number> | undefined) => new Map(Object.entries(o ?? {}));
const setMap = (o: Record<string, string[]> | undefined) =>
  new Map(Object.entries(o ?? {}).map(([k, v]) => [k, new Set(v)]));

export function fromPayload(
  p: Payload,
  window: UsageWindow & { computedAt: string },
): UsageSnapshot {
  const skills = new Map<string, Map<string, TeamUse>>();
  for (const [skillId, teams] of Object.entries(p.skills ?? {}))
    skills.set(
      skillId,
      new Map(
        Object.entries(teams).map(([teamId, u]) => [
          teamId,
          {
            installed: u.i,
            running: u.r,
            optedOut: u.o,
            runs: numMap(u.runs),
            members: setMap(u.members),
            up: numMap(u.up),
            down: numMap(u.down),
            raters: setMap(u.raters),
          },
        ]),
      ),
    );
  return { ...window, skills };
}

const iso = (v: unknown) => new Date(v as string | Date).toISOString();

async function storedRow(db: KobeDb, from: string | null): Promise<UsageSnapshot | null> {
  const r = await db.execute<{
    window_start: string;
    window_end: string;
    computed_at: string;
    payload: Payload;
  }>(sql`
    SELECT window_start, window_end, computed_at, payload FROM skill_usage_snapshots
     ${from ? sql`WHERE window_start = ${from}::timestamptz` : sql``}
     ORDER BY window_start DESC LIMIT 1`);
  const row = r.rows[0];
  if (!row) return null;
  return fromPayload(row.payload, {
    from: iso(row.window_start),
    to: iso(row.window_end),
    computedAt: iso(row.computed_at),
  });
}

/**
 * Computes and stores the last closed window's snapshot if nobody has: one replica at a time (a
 * session advisory lock on a dedicated connection), written once (`ON CONFLICT DO NOTHING`), and
 * windows older than the previous one purged. Returns whether this call stored it.
 */
export async function ensureUsageSnapshot(
  deps: { readonly db: KobeDb; readonly pool: KobeDatabase["pool"] },
  now: Date = new Date(),
): Promise<boolean> {
  const window = closedWindow(now);
  const have = await deps.db.execute(sql`
    SELECT 1 FROM skill_usage_snapshots WHERE window_start = ${window.from}::timestamptz`);
  if (have.rows.length > 0) return false;
  const client = await deps.pool.connect();
  let destroy = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
      [LOCK],
    );
    if (!rows[0]?.locked) return false;
    try {
      const again = await deps.db.execute(sql`
        SELECT 1 FROM skill_usage_snapshots WHERE window_start = ${window.from}::timestamptz`);
      if (again.rows.length > 0) return false;
      const snapshot = await computeUsageSnapshot(deps.db, window, now);
      await deps.db.execute(sql`
        INSERT INTO skill_usage_snapshots (window_start, window_end, payload)
        VALUES (${window.from}::timestamptz, ${window.to}::timestamptz,
          ${JSON.stringify(toPayload(snapshot))}::jsonb)
        ON CONFLICT (window_start) DO NOTHING`);
      await deps.db.execute(sql`
        DELETE FROM skill_usage_snapshots
         WHERE window_start < ${window.from}::timestamptz - make_interval(days => ${USAGE_WINDOW_DAYS})`);
      return true;
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [LOCK]).catch(() => {
        destroy = true;
      });
    }
  } finally {
    client.release(destroy);
  }
}

/**
 * The snapshot to serve: the last closed window's stored row, or, while it isn't stored yet (the
 * job runs at start and hourly), the newest stored one (also a closed window, so its numbers are
 * final). With none stored at all, an empty snapshot (every number reads "few"). Stored rows never
 * change, so a replica caches the one it serves and only looks for the newer one now and then.
 */
let cache: { key: string; snapshot: UsageSnapshot; checkedAt: number } | null = null;
const RECHECK_MS = 60_000;

export async function usageSnapshot(db: KobeDb, now: Date = new Date()): Promise<UsageSnapshot> {
  const window = closedWindow(now);
  if (cache?.key === window.from) return cache.snapshot;
  if (cache && now.getTime() - cache.checkedAt < RECHECK_MS) return cache.snapshot;
  const stored = (await storedRow(db, window.from)) ?? (await storedRow(db, null));
  const snapshot = stored ?? { ...window, computedAt: now.toISOString(), skills: new Map() };
  cache = { key: stored?.from ?? "", snapshot, checkedAt: now.getTime() };
  return snapshot;
}

/** Tests: drop the cached snapshot. */
export function forgetUsageSnapshot(): void {
  cache = null;
}

/** The teams the viewer belongs to now (review M3), plus the active one. */
export async function viewerTeamsOf(
  db: KobeDb,
  userId: string,
  activeTeamId?: string,
): Promise<Set<string>> {
  const teams = new Set((await listMemberships(db, userId)).map((m) => m.teamId));
  if (activeTeamId) teams.add(activeTeamId);
  return teams;
}

/** How often each replica checks whether the last closed window is stored. */
export const USAGE_CHECK_MS = 60 * 60_000;

/**
 * The refresh job (ac-1): at start and every hour, stores the last closed window's snapshot if no
 * replica has yet. A failure is logged and retried at the next check. Returns how to stop it.
 */
export function startUsageSnapshots(deps: {
  readonly db: KobeDb;
  readonly pool: KobeDatabase["pool"];
  readonly log: { error(obj: object, msg: string): void };
}): () => void {
  const run = () => {
    ensureUsageSnapshot(deps).catch((err: unknown) =>
      deps.log.error({ err }, "skill usage snapshot failed"),
    );
  };
  run();
  const timer = setInterval(run, USAGE_CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
