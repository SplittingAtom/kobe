import {
  MEMORY_SITE_ENABLED_KEY,
  eq,
  inArray,
  siteSettings,
  teamMemorySettings,
  type KobeTx,
} from "@kobe/db";
import type { MemoryScope } from "@kobe/protocol";

/**
 * The memory switches (D24), in one place. Two levels (site admins, team admins), each with
 * `memory_enabled` and `project_memory_enabled` (default on). A scope is effective only when both
 * levels allow it; `project` also needs `memory_enabled`. The site level is two
 * `site_settings` keys (`false` = off, absent = on), the team level `team_memory_settings`
 * (no row = both on).
 */

export const MEMORY_SITE_PROJECT_ENABLED_KEY = "memory.project_enabled";

export interface SwitchPair {
  readonly memoryEnabled: boolean;
  readonly projectMemoryEnabled: boolean;
}

export interface MemorySwitches {
  readonly site: SwitchPair;
  readonly team: SwitchPair;
  /** Which scopes work for this team now. */
  readonly effective: Readonly<Record<MemoryScope, boolean>>;
}

export async function readSiteSwitches(tx: KobeTx): Promise<SwitchPair> {
  const rows = await tx
    .select({ key: siteSettings.key, value: siteSettings.value })
    .from(siteSettings)
    .where(inArray(siteSettings.key, [MEMORY_SITE_ENABLED_KEY, MEMORY_SITE_PROJECT_ENABLED_KEY]));
  const off = (key: string) => rows.some((r) => r.key === key && r.value === "false");
  return {
    memoryEnabled: !off(MEMORY_SITE_ENABLED_KEY),
    projectMemoryEnabled: !off(MEMORY_SITE_PROJECT_ENABLED_KEY),
  };
}

export async function readTeamSwitches(tx: KobeTx, teamId: string): Promise<SwitchPair> {
  const [row] = await tx
    .select({
      memoryEnabled: teamMemorySettings.memoryEnabled,
      projectMemoryEnabled: teamMemorySettings.projectMemoryEnabled,
    })
    .from(teamMemorySettings)
    .where(eq(teamMemorySettings.teamId, teamId));
  return row ?? { memoryEnabled: true, projectMemoryEnabled: true };
}

export async function readSwitches(tx: KobeTx, teamId: string): Promise<MemorySwitches> {
  const site = await readSiteSwitches(tx);
  const team = await readTeamSwitches(tx, teamId);
  const user = site.memoryEnabled && team.memoryEnabled;
  return {
    site,
    team,
    effective: {
      user,
      project: user && site.projectMemoryEnabled && team.projectMemoryEnabled,
    },
  };
}

/** The single gate every memory operation passes: is `scope` on for this team? */
export async function scopeEnabled(
  tx: KobeTx,
  teamId: string,
  scope: MemoryScope,
): Promise<boolean> {
  return (await readSwitches(tx, teamId)).effective[scope];
}

export async function writeTeamSwitches(
  tx: KobeTx,
  teamId: string,
  userId: string,
  change: Partial<SwitchPair>,
): Promise<SwitchPair> {
  const current = await readTeamSwitches(tx, teamId);
  const next: SwitchPair = {
    memoryEnabled: change.memoryEnabled ?? current.memoryEnabled,
    projectMemoryEnabled: change.projectMemoryEnabled ?? current.projectMemoryEnabled,
  };
  await tx
    .insert(teamMemorySettings)
    .values({ teamId, ...next, updatedBy: userId })
    .onConflictDoUpdate({
      target: teamMemorySettings.teamId,
      set: { ...next, updatedBy: userId, updatedAt: new Date() },
    });
  return next;
}

export async function writeSiteSwitches(
  tx: KobeTx,
  change: Partial<SwitchPair>,
): Promise<SwitchPair> {
  const current = await readSiteSwitches(tx);
  const next: SwitchPair = {
    memoryEnabled: change.memoryEnabled ?? current.memoryEnabled,
    projectMemoryEnabled: change.projectMemoryEnabled ?? current.projectMemoryEnabled,
  };
  const entries = [
    [MEMORY_SITE_ENABLED_KEY, next.memoryEnabled],
    [MEMORY_SITE_PROJECT_ENABLED_KEY, next.projectMemoryEnabled],
  ] as const;
  for (const [key, on] of entries) {
    const value = String(on);
    await tx
      .insert(siteSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: new Date() } });
  }
  return next;
}
