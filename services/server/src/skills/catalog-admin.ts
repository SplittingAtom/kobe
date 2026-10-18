import { scanTeams, sql, type KobeDb } from "@kobe/db";
import { defaultTargets } from "./default-target.js";

/**
 * The Site console's view of catalog tags (KOBE-314, SK5–SK8, SK26): each catalog skill with its
 * tags, newest approved version and, for Default skills, the major Default installs follow and
 * how many teams opted out. Opt-out counts obey the minimum-count rule: fewer than
 * {@link MIN_TEAMS} teams (but some) shows as "few"; never team names.
 */
export const MIN_TEAMS = 3;

export interface SiteCatalogSkill {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly publisher: string;
  readonly status: string;
  readonly latest: string | null;
  readonly system: string[];
  readonly topic: string[];
  /** Default skills only. */
  readonly defaultMajor: number | null;
  readonly optOuts: number | "few" | null;
}

/** Opt-outs per skill across teams (each team read under its own RLS), then the count rule. */
async function optOutCounts(db: KobeDb, skillIds: readonly string[]) {
  const counts = new Map<string, number>(skillIds.map((id) => [id, 0]));
  if (skillIds.length === 0) return counts;
  const rows = await scanTeams(db, "optOutCounts", async (tx, team) => {
    const r = await tx.execute<{ skill_id: string }>(sql`
      SELECT skill_id FROM team_skill_optouts WHERE team_id = ${team.id}`);
    return r.rows.map((x) => x.skill_id);
  });
  for (const id of rows.flat()) if (counts.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

const shown = (n: number): number | "few" => (n > 0 && n < MIN_TEAMS ? "few" : n);

export async function listSiteCatalog(db: KobeDb): Promise<SiteCatalogSkill[]> {
  const { rows } = await db.execute<{
    id: string;
    name: string;
    summary: string;
    publisher: string;
    status: string;
    latest: string | null;
    system: string[] | null;
    topic: string[] | null;
  }>(sql`
    SELECT s.id, s.name, s.summary, s.publisher::text, s.status::text,
      (SELECT v.semver FROM registry_versions v
        WHERE v.skill_id = s.id AND v.state = 'approved' AND v.suspended_at IS NULL
        ORDER BY v.seq DESC LIMIT 1) AS latest,
      array(SELECT t.name FROM registry_skill_tags st JOIN registry_tags t ON t.id = st.tag_id
        WHERE st.skill_id = s.id AND t.kind = 'system' ORDER BY t.name) AS system,
      array(SELECT t.name FROM registry_skill_tags st JOIN registry_tags t ON t.id = st.tag_id
        WHERE st.skill_id = s.id AND t.kind = 'topic' ORDER BY t.name) AS topic
    FROM registry_skills s ORDER BY s.name`);
  const majors = new Map((await defaultTargets(db)).map((t) => [t.skillId, t.major]));
  const counts = await optOutCounts(db, [...majors.keys()]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    summary: r.summary,
    publisher: r.publisher,
    status: r.status,
    latest: r.latest,
    system: r.system ?? [],
    topic: r.topic ?? [],
    defaultMajor: majors.get(r.id) ?? null,
    optOuts: majors.has(r.id) ? shown(counts.get(r.id) ?? 0) : null,
  }));
}

export interface DefaultSyncRow {
  readonly id: string;
  readonly skillId: string;
  readonly name: string;
  readonly kind: string;
  readonly major: number | null;
  readonly status: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly teamsTotal: number;
  readonly teamsDone: number;
  readonly installed: number;
  readonly kept: number;
  readonly optedOut: number | "few";
  readonly converted: number;
  readonly optoutsCleared: number;
  readonly moved: number;
}

const SHOWN_SYNCS = 20;
const iso = (v: unknown) => (v === null ? null : v instanceof Date ? v.toISOString() : String(v));

/**
 * The newest Default sync jobs with their progress. Team counts are totals over the whole Site
 * (no team names); the opted-out count of a job obeys the minimum-count rule too.
 */
export async function listDefaultSyncs(db: KobeDb): Promise<DefaultSyncRow[]> {
  const { rows } = await db.execute<Record<string, unknown>>(sql`
    SELECT j.*, s.name FROM skill_default_syncs j JOIN registry_skills s ON s.id = j.skill_id
    ORDER BY j.created_at DESC, j.id DESC LIMIT ${SHOWN_SYNCS}`);
  return rows.map((r) => ({
    id: String(r.id),
    skillId: String(r.skill_id),
    name: String(r.name),
    kind: String(r.kind),
    major: r.major === null ? null : Number(r.major),
    status: String(r.status),
    createdAt: iso(r.created_at) ?? "",
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    teamsTotal: Number(r.teams_total),
    teamsDone: Number(r.teams_done),
    installed: Number(r.installed),
    kept: Number(r.kept),
    optedOut: shown(Number(r.opted_out)),
    converted: Number(r.converted),
    optoutsCleared: Number(r.optouts_cleared),
    moved: Number(r.moved),
  }));
}
