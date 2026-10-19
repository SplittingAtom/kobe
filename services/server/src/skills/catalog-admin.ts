import { sql, type KobeDb } from "@kobe/db";
import { usageSnapshot, viewerTeamsOf } from "./usage-snapshot.js";
import { optOutCount } from "./usage-views.js";
import { isMasked } from "./default-sync-run.js";
import { defaultTargets } from "./default-target.js";

/**
 * The Site console's view of catalog tags (KOBE-314, SK5–SK8, SK26): each catalog skill with its
 * tags, newest approved version and, for Default skills, the major Default installs follow and
 * how many teams opted out, under the usage minimum-count rule (`usage-views.ts`); never team
 * names.
 */

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

/**
 * The Site console's catalog. Default opt-out counts come from the last closed usage window under
 * the minimum-count rule, the viewer's own teams left out (KOBE-339 review M4): never live, so
 * watching the page can't catch one team's opt-out.
 */
export async function listSiteCatalog(db: KobeDb, viewerId: string): Promise<SiteCatalogSkill[]> {
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
  const snapshot = await usageSnapshot(db);
  const viewer = await viewerTeamsOf(db, viewerId);
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
    optOuts: majors.has(r.id) ? optOutCount(snapshot, r.id, viewer) : null,
  }));
}

/** Counts of a job by outcome; null when the minimum-count rule hides them (SK26). */
export interface DefaultSyncCounts {
  readonly installed: number;
  readonly kept: number;
  readonly optedOut: number;
  readonly blocked: number;
  readonly nameConflicts: number;
  readonly converted: number;
  readonly optoutsCleared: number;
  readonly moved: number;
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
  /**
   * Null when a team count among them (opted out, opt-outs cleared, blocked) is 1 or 2: showing
   * the others would give it away by subtraction, so the whole breakdown is hidden.
   */
  readonly counts: DefaultSyncCounts | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly nextAttemptAt: string | null;
}

const SHOWN_SYNCS = 20;
const ENDED = new Set(["done", "failed"]);
const iso = (v: unknown) => (v === null ? null : v instanceof Date ? v.toISOString() : String(v));

/** The newest Default sync jobs with their progress; totals only, never team names. */
export async function listDefaultSyncs(db: KobeDb): Promise<DefaultSyncRow[]> {
  const { rows } = await db.execute<Record<string, unknown>>(sql`
    SELECT j.*, s.name FROM skill_default_syncs j JOIN registry_skills s ON s.id = j.skill_id
    ORDER BY j.seq DESC LIMIT ${SHOWN_SYNCS}`);
  return rows.map((r) => {
    const counts: DefaultSyncCounts = {
      installed: Number(r.installed),
      kept: Number(r.kept),
      optedOut: Number(r.opted_out),
      blocked: Number(r.blocked),
      nameConflicts: Number(r.name_conflicts),
      converted: Number(r.converted),
      optoutsCleared: Number(r.optouts_cleared),
      moved: Number(r.moved),
    };
    return {
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
      // While the job runs, its counts move one team at a time in id order, so a step in a team
      // count would name that team (review N-314a): progress only, counts once it has ended.
      counts: isMasked(counts) || !ENDED.has(String(r.status)) ? null : counts,
      attempts: Number(r.attempts),
      lastError: r.last_error === null ? null : String(r.last_error),
      nextAttemptAt: iso(r.next_attempt_at),
    };
  });
}
