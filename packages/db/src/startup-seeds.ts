/**
 * Rows the server writes into a fresh site when it starts, before anyone signs up (KOBE-422):
 * the gallery agents (`services/server/src/gallery/seed.ts`, at every start), the audit events
 * of that seeding, and the background jobs' own bookkeeping in `site_settings`. `kobe restore`
 * accepts a target holding only these and replaces them with the backup's rows, in its one
 * transaction; any other row in these tables (a personal agent, a person's audit event, a setting
 * someone chose) is real data and the target is refused.
 *
 * `rows` is a SQL condition over one row of the table (unqualified column names), true for a
 * startup-seeded row. `services/server/src/startup-seeds.db.test.ts` runs the server's start-up
 * writers on a fresh database and fails when one writes a row these conditions don't cover, so a
 * new start-up writer must be added here.
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

/** `site_settings` keys only background jobs write: where a pass or a sweep stands. */
export const JOB_SETTING_KEYS = [
  "retention.pass_started_at",
  "retention.last_pass_at",
  "retention.cursor",
  "audit.pii_sweep_seq",
  "audit.pii_sweep_resume_at",
] as const;

const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");

export const STARTUP_SEEDED_ROWS: Readonly<Record<string, StartupSeed>> = {
  site_agents: {
    why: "gallery agents seeded at every server start (KOBE-87)",
    rows: "gallery_key IS NOT NULL",
  },
  site_agent_versions: {
    why: "the versions the gallery seed publishes (no person publishes them)",
    rows: "published_by IS NULL AND agent_id IN (SELECT id FROM public.site_agents WHERE gallery_key IS NOT NULL)",
  },
  audit_log: {
    why: "the system's audit events of the gallery seed",
    rows: `actor_kind = 'system' AND actor_id IS NULL AND team_id IS NULL AND action IN (${list(GALLERY_AUDIT_ACTIONS)}) AND target ->> 'scope' = 'gallery'`,
  },
  site_settings: {
    why: "where the retention pass and the audit PII sweep stand (KOBE-18, KOBE-17)",
    rows: `key IN (${list(JOB_SETTING_KEYS)})`,
  },
};

export function startupSeed(table: string): StartupSeed | undefined {
  return Object.hasOwn(STARTUP_SEEDED_ROWS, table) ? STARTUP_SEEDED_ROWS[table] : undefined;
}
