import {
  MEMORY_SITE_ENABLED_KEY,
  MODEL_ALIAS_PATTERN,
  inArray,
  siteSettings,
  sql,
  teamMemorySettings,
  type KobeTx,
} from "@kobe/db";
import type { MemoryScope } from "@kobe/protocol";
import {
  SITE_SWITCH_NAMES,
  WORKSPACE_SWITCHES_ON,
  effectiveMemory,
  type Change,
  type EffectiveMemory,
  type SiteMemorySwitches,
  type WorkspaceMemorySwitches,
} from "./switch-model.js";

export * from "./switch-model.js";

/**
 * The memory switches (D24, widened by KOBE-381 / SM27), stored without a migration:
 *
 * - Site: one `site_settings` key per switch (`false` = off; absent or anything else = on).
 * - Workspace: the master and project Notes switches stay the `team_memory_settings` columns
 *   (no row = on); the v1.3 switches and the learning model override are the `teams.settings`
 *   key `memory` (a JSON object; a missing or non-boolean value = on, a missing alias = none).
 *
 * See `switch-model.ts` for the AND rules. Turning anything off deletes nothing.
 */

export const MEMORY_SITE_PROJECT_ENABLED_KEY = "memory.project_enabled";

/** The `site_settings` key of each Site switch. */
export const SITE_SWITCH_KEYS: Readonly<Record<keyof SiteMemorySwitches, string>> = {
  memoryEnabled: MEMORY_SITE_ENABLED_KEY,
  projectMemoryEnabled: MEMORY_SITE_PROJECT_ENABLED_KEY,
  memoriesEnabled: "memory.memories_enabled",
  portableEnabled: "memory.portable_enabled",
  learnEnabled: "memory.learn_enabled",
  siteProposalsEnabled: "memory.site_proposals_enabled",
};

/** The `teams.settings` key of the Workspace's v1.3 memory switches. */
export const TEAM_MEMORY_SETTING = "memory";

/** The JSON field of each v1.3 Workspace value inside `teams.settings.memory`. */
const TEAM_JSON_FIELDS = {
  memoriesEnabled: "memories_enabled",
  workspaceMemoriesEnabled: "workspace_memories_enabled",
  siteMemoriesEnabled: "site_memories_enabled",
  learnEnabled: "learn_enabled",
  siteProposalsEnabled: "site_proposals_enabled",
} as const;
type TeamJsonSwitch = keyof typeof TEAM_JSON_FIELDS;
const TEAM_JSON_SWITCHES = Object.keys(TEAM_JSON_FIELDS) as TeamJsonSwitch[];
const ALIAS_FIELD = "learning_model_alias";
const ALIAS = new RegExp(MODEL_ALIAS_PATTERN);

/** Kept for the Notes callers: the two D24 switches of one level. */
export interface SwitchPair {
  readonly memoryEnabled: boolean;
  readonly projectMemoryEnabled: boolean;
}

export interface MemorySwitches {
  readonly site: SiteMemorySwitches;
  readonly team: WorkspaceMemorySwitches;
  /** Which Notes scopes work for this team now. */
  readonly effective: Readonly<Record<MemoryScope, boolean>>;
  /** Everything that applies (Notes, Memories, Policy, Learn, Site proposals). */
  readonly memory: EffectiveMemory;
  /**
   * A learning model alias is stored for the Workspace but no longer parses (review L5): Learn is
   * unavailable, never the Site's model. `team.learningModelAlias` reads null then.
   */
  readonly teamAliasInvalid: boolean;
}

export async function readSiteSwitches(tx: KobeTx): Promise<SiteMemorySwitches> {
  const rows = await tx
    .select({ key: siteSettings.key, value: siteSettings.value })
    .from(siteSettings)
    .where(inArray(siteSettings.key, Object.values(SITE_SWITCH_KEYS)));
  const off = (key: string) => rows.some((r) => r.key === key && r.value === "false");
  const out: Record<string, boolean> = {};
  for (const name of SITE_SWITCH_NAMES) out[name] = !off(SITE_SWITCH_KEYS[name]);
  return out as unknown as SiteMemorySwitches;
}

/** The `teams.settings.memory` object over the defaults (pure). */
export function parseTeamMemoryJson(
  raw: unknown,
): Omit<WorkspaceMemorySwitches, "memoryEnabled" | "projectMemoryEnabled"> {
  const obj =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const flag = (name: TeamJsonSwitch) => obj[TEAM_JSON_FIELDS[name]] !== false;
  const alias = obj[ALIAS_FIELD];
  return {
    memoriesEnabled: flag("memoriesEnabled"),
    workspaceMemoriesEnabled: flag("workspaceMemoriesEnabled"),
    siteMemoriesEnabled: flag("siteMemoriesEnabled"),
    learnEnabled: flag("learnEnabled"),
    siteProposalsEnabled: flag("siteProposalsEnabled"),
    learningModelAlias: typeof alias === "string" && ALIAS.test(alias) ? alias : null,
  };
}

/** A stored, present alias that fails the pattern (pure). */
export function storedAliasInvalid(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const alias = (raw as Record<string, unknown>)[ALIAS_FIELD];
  return alias !== undefined && alias !== null && !(typeof alias === "string" && ALIAS.test(alias));
}

export async function readTeamSwitches(
  tx: KobeTx,
  teamId: string,
): Promise<WorkspaceMemorySwitches> {
  return (await readTeamState(tx, teamId)).switches;
}

async function readTeamState(
  tx: KobeTx,
  teamId: string,
): Promise<{ switches: WorkspaceMemorySwitches; aliasInvalid: boolean }> {
  const res = await tx.execute<{
    memory_enabled: boolean | null;
    project_memory_enabled: boolean | null;
    memory: unknown;
  }>(sql`
    SELECT s.memory_enabled, s.project_memory_enabled,
           (SELECT CASE WHEN jsonb_typeof(t.settings) = 'object'
                        THEN t.settings -> ${TEAM_MEMORY_SETTING} END
              FROM teams t WHERE t.id = ${teamId}) AS memory
      FROM (SELECT 1) one
      LEFT JOIN team_memory_settings s ON s.team_id = ${teamId}`);
  const row = res.rows[0];
  return {
    switches: {
      memoryEnabled: row?.memory_enabled ?? WORKSPACE_SWITCHES_ON.memoryEnabled,
      projectMemoryEnabled:
        row?.project_memory_enabled ?? WORKSPACE_SWITCHES_ON.projectMemoryEnabled,
      ...parseTeamMemoryJson(row?.memory ?? null),
    },
    aliasInvalid: storedAliasInvalid(row?.memory ?? null),
  };
}

export async function readSwitches(tx: KobeTx, teamId: string): Promise<MemorySwitches> {
  const site = await readSiteSwitches(tx);
  const { switches: team, aliasInvalid } = await readTeamState(tx, teamId);
  const memory = effectiveMemory(site, team);
  return { site, team, effective: memory.notes, memory, teamAliasInvalid: aliasInvalid };
}

/** The single gate every Notes operation passes: is `scope` on for this team? */
export async function scopeEnabled(
  tx: KobeTx,
  teamId: string,
  scope: MemoryScope,
): Promise<boolean> {
  return (await readSwitches(tx, teamId)).effective[scope];
}

const sameWorkspace = (a: WorkspaceMemorySwitches, b: WorkspaceMemorySwitches) =>
  (Object.keys(WORKSPACE_SWITCHES_ON) as (keyof WorkspaceMemorySwitches)[]).every(
    (k) => a[k] === b[k],
  );

/**
 * Saves the given Workspace values over the current ones. `expected` (KOBE-621): the Workspace's
 * values as the caller saw them (a Kobe MCP write's approved before-state); any other current
 * state, read under the team's switch lock, changes nothing. Only the fields given are written.
 */
export async function writeTeamSwitches(
  tx: KobeTx,
  teamId: string,
  userId: string,
  change: Change<WorkspaceMemorySwitches>,
  expected?: WorkspaceMemorySwitches,
): Promise<
  | { readonly before: WorkspaceMemorySwitches; readonly after: WorkspaceMemorySwitches }
  | "changed_since_approval"
> {
  // Team switch writes serialize per team (the row may not exist yet, so no row lock).
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kobe.memory-switches:${teamId}`}, 0))`,
  );
  const current = await readTeamSwitches(tx, teamId);
  if (expected !== undefined && !sameWorkspace(expected, current)) return "changed_since_approval";
  const next: WorkspaceMemorySwitches = { ...current, ...definedOnly(change) };
  if (change.memoryEnabled !== undefined || change.projectMemoryEnabled !== undefined) {
    const pair = {
      memoryEnabled: next.memoryEnabled,
      projectMemoryEnabled: next.projectMemoryEnabled,
    };
    await tx
      .insert(teamMemorySettings)
      .values({ teamId, ...pair, updatedBy: userId })
      .onConflictDoUpdate({
        target: teamMemorySettings.teamId,
        set: { ...pair, updatedBy: userId, updatedAt: new Date() },
      });
  }
  const jsonChange: Record<string, boolean | string | null> = {};
  for (const name of TEAM_JSON_SWITCHES) {
    if (change[name] !== undefined) jsonChange[TEAM_JSON_FIELDS[name]] = next[name];
  }
  if (change.learningModelAlias !== undefined) jsonChange[ALIAS_FIELD] = next.learningModelAlias;
  if (Object.keys(jsonChange).length > 0) {
    await tx.execute(sql`
      UPDATE teams
         SET settings = jsonb_set(
               CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END,
               ${`{${TEAM_MEMORY_SETTING}}`}::text[],
               (CASE WHEN jsonb_typeof(settings -> ${TEAM_MEMORY_SETTING}) = 'object'
                     THEN settings -> ${TEAM_MEMORY_SETTING} ELSE '{}'::jsonb END)
                 || ${JSON.stringify(jsonChange)}::jsonb)
       WHERE id = ${teamId}`);
  }
  return { before: current, after: next };
}

/** One lock for every Site memory switch and setting write (review L1). */
export async function lockSiteMemorySettings(tx: KobeTx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('kobe.memory-site', 0))`);
}

export async function writeSiteSwitches(
  tx: KobeTx,
  change: Change<SiteMemorySwitches>,
): Promise<{ readonly before: SiteMemorySwitches; readonly after: SiteMemorySwitches }> {
  const current = await readSiteSwitches(tx);
  const next: SiteMemorySwitches = { ...current, ...definedOnly(change) };
  for (const name of SITE_SWITCH_NAMES) {
    if (change[name] === undefined) continue;
    const value = String(next[name]);
    await tx
      .insert(siteSettings)
      .values({ key: SITE_SWITCH_KEYS[name], value })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: new Date() } });
  }
  return { before: current, after: next };
}

function definedOnly<T extends object>(change: Change<T>): Partial<T> {
  return Object.fromEntries(
    Object.entries(change).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
