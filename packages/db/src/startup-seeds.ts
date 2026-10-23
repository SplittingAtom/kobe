/**
 * Rows the server writes into a fresh site when it starts, before anyone signs up (KOBE-422):
 * the gallery agents (`services/server/src/gallery/seed.ts`, at every start), Kobe's own catalog
 * skills (`services/server/src/skills/kobe-seed.ts`, KOBE-317) with their Default tags and sync
 * jobs, the audit events of that seeding, and the background jobs' own bookkeeping in
 * `site_settings` (retention, PII erasure, SIEM forwarding). The catalog skills' bytes in the
 * bucket (`<prefix>skills/catalog/<sha256>`) need nothing here: the restore leaves objects that
 * are not in the backup untouched, and the backup's rows name the same content-addressed keys.
 * `kobe restore`
 * accepts a target holding only these and replaces them with the backup's rows, in its one
 * transaction; any other row in these tables (a personal agent, a person's audit event, a setting
 * someone chose) is real data and the target is refused.
 *
 * `rows` is a SQL condition over one row of the table (unqualified column names), true for a
 * startup-seeded row. `services/server/src/startup-seeds.db.test.ts` runs one pass of the
 * server's start-up jobs (`services/server/src/startup/jobs.ts`, the list `index.ts` starts) on
 * a fresh database and fails when one writes a row these conditions don't cover, so a new
 * start-up writer must be added here.
 */
export interface StartupSeed {
  readonly why: string;
  readonly rows: string;
}

/** The gallery's own audit actions, written by the system (no actor, no team). */
const GALLERY_AUDIT_ACTIONS = [
  "agent.created",
  "agent.updated",
  "agent.published",
  "agent.archived",
  "agent.unarchived",
] as const;

/** The Default sync's system events (KOBE-314); only those for Kobe's own skills are seeds. */
const DEFAULT_SYNC_AUDIT_ACTIONS = [
  "skill.default.synced",
  "skill.default.sync_failed",
  "skill.default.applied",
] as const;

/** Kobe's own catalog skills (publisher `kobe`, KOBE-317), as a subquery of their ids. */
const KOBE_SKILL_IDS = "SELECT id FROM public.registry_skills WHERE publisher = 'kobe'";

/** `site_settings` keys only background jobs write: where a pass or a sweep stands. */
export const JOB_SETTING_KEYS = [
  "retention.pass_started_at",
  "retention.last_pass_at",
  "retention.cursor",
  "audit.pii_sweep_seq",
  "audit.pii_sweep_resume_at",
] as const;

/** Per destination (`audit.forward.syslog`, `audit.forward.otlp`): the forwarder's position. */
export const FORWARD_STATE_PREFIX = "audit.forward.";

const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");

export const STARTUP_SEEDED_ROWS: Readonly<Record<string, StartupSeed>> = {
  site_agents: {
    why: "gallery agents seeded at every server start (KOBE-87)",
    // Archived only by the seed itself (a person's archive is real data), and not customized by
    // a site admin (KOBE-494: their edits are real data too).
    rows: "gallery_key IS NOT NULL AND (archived_by IS NULL OR archived_by = 'seed') AND customized_at IS NULL",
  },
  site_agent_versions: {
    why: "the versions the gallery seed publishes (no person publishes them)",
    rows: "published_by IS NULL AND agent_id IN (SELECT id FROM public.site_agents WHERE gallery_key IS NOT NULL)",
  },
  registry_skills: {
    why: "Kobe's own catalog skills, published at every server start (KOBE-317)",
    rows: "publisher = 'kobe'",
  },
  registry_versions: {
    why: "the versions of Kobe's catalog skills the seed publishes (no person submits them)",
    rows: "publisher = 'kobe'",
  },
  registry_skill_tags: {
    why: "the Default tags the Kobe skills seed adds (no person adds them)",
    rows: "by_kobe",
  },
  skill_default_syncs: {
    why: "the Default sync jobs the Kobe skills seed queues (no person requests them)",
    rows: "by_kobe",
  },
  team_skill_installs: {
    why: "installs Kobe's own Default sync makes (none on a fresh site: it has no teams)",
    rows: "by_kobe",
  },
  skill_rescan_runs: {
    why: "the rescan job's pass per scanner rule set (KOBE-313); one that suspended a version is real data",
    rows: "suspended = 0 AND jsonb_array_length(suspensions) = 0",
  },
  skill_usage_snapshots: {
    why: "catalog usage aggregates the usage job computes per closed window (KOBE-339); derived, recomputed",
    rows: "true",
  },
  audit_log: {
    why: "the system's audit events of the gallery and Kobe skills seeds, and of the Default sync of Kobe's skills",
    rows:
      `actor_kind = 'system' AND actor_id IS NULL AND (` +
      `(team_id IS NULL AND action IN (${list(GALLERY_AUDIT_ACTIONS)}) AND target ->> 'scope' = 'gallery')` +
      ` OR (team_id IS NULL AND action = 'skill.kobe.published')` +
      // A site admin's Default jobs write the same system events for their skills: real data.
      ` OR (action IN (${list(DEFAULT_SYNC_AUDIT_ACTIONS)}) AND target ->> 'skillId' IN (SELECT id::text FROM (${KOBE_SKILL_IDS}) k))` +
      `)`,
  },
  site_settings: {
    why: "where the retention pass, the audit PII sweep and SIEM forwarding stand (KOBE-18, KOBE-17, KOBE-19)",
    rows: `key IN (${list(JOB_SETTING_KEYS)}) OR key LIKE '${FORWARD_STATE_PREFIX}%'`,
  },
};

export function startupSeed(table: string): StartupSeed | undefined {
  return Object.hasOwn(STARTUP_SEEDED_ROWS, table) ? STARTUP_SEEDED_ROWS[table] : undefined;
}
