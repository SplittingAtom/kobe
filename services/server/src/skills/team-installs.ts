import { sql, withTeam, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { addInTeam } from "./default-sync-team.js";
import {
  defaultTargets,
  defaultVersion,
  isDefaultSkill,
  lockDefaultSet,
  lockInstall,
} from "./default-target.js";

/**
 * A team's catalog installs (KOBE-314, SK6, SK7, SK25): what the team runs from the Catalog, its
 * Removed defaults, and the two Team admin acts this ticket adds: uninstall (on a Default skill it
 * records a sticky opt-out) and Reinstall of a removed default (clears the opt-out).
 */
export interface InstallRow {
  readonly skillId: string;
  readonly name: string;
  readonly versionId: string;
  readonly semver: string;
  readonly pinMode: "pinned" | "within_major" | "latest";
  readonly access: "available" | "default_on" | "required" | "hidden";
  readonly origin: "team" | "default_tag";
  readonly installedBy: string;
  readonly updatedAt: string;
  /** The skill carries the Default tag (the "Site default" badge). */
  readonly isDefault: boolean;
}

export interface RemovedDefault {
  readonly skillId: string;
  readonly name: string;
  readonly optedOutBy: string;
  readonly reason: string | null;
  readonly at: string;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

export async function listTeamInstalls(
  db: KobeDb,
  teamId: string,
): Promise<{ installs: InstallRow[]; removedDefaults: RemovedDefault[] }> {
  return withTeam(db, teamId, async (tx) => {
    const installs = await tx.execute<Record<string, unknown>>(sql`
      SELECT i.skill_id, s.name, i.version_id, v.semver, i.pin_mode, i.access, i.origin,
        i.installed_by, i.updated_at,
        EXISTS (SELECT 1 FROM registry_skill_tags st JOIN registry_tags t ON t.id = st.tag_id
          WHERE st.skill_id = i.skill_id AND t.kind = 'system' AND t.name = 'default') AS is_default
      FROM team_skill_installs i
      JOIN registry_skills s ON s.id = i.skill_id
      JOIN registry_versions v ON v.id = i.version_id
      WHERE i.team_id = ${teamId}
      ORDER BY s.name`);
    const removed = await tx.execute<Record<string, unknown>>(sql`
      SELECT o.skill_id, s.name, o.opted_out_by, o.reason, o.at
      FROM team_skill_optouts o JOIN registry_skills s ON s.id = o.skill_id
      WHERE o.team_id = ${teamId}
      ORDER BY s.name`);
    return {
      installs: installs.rows.map((r) => ({
        skillId: String(r.skill_id),
        name: String(r.name),
        versionId: String(r.version_id),
        semver: String(r.semver),
        pinMode: r.pin_mode as InstallRow["pinMode"],
        access: r.access as InstallRow["access"],
        origin: r.origin as InstallRow["origin"],
        installedBy: String(r.installed_by),
        updatedAt: iso(r.updated_at),
        isDefault: Boolean(r.is_default),
      })),
      removedDefaults: removed.rows.map((r) => ({
        skillId: String(r.skill_id),
        name: String(r.name),
        optedOutBy: String(r.opted_out_by),
        reason: r.reason === null ? null : String(r.reason),
        at: iso(r.at),
      })),
    };
  });
}

export type UninstallResult =
  | { readonly ok: true; readonly optedOut: boolean }
  | { readonly ok: false; readonly code: "not_found" };

/**
 * Uninstalls a catalog skill from the team. When the skill carries the Default tag (whoever made
 * the install), the team opts out: later Default syncs (upgrade, re-tag) skip it until a Team admin
 * reinstalls it (SK7). Audited; the reason is stored, not audited.
 */
export async function uninstallCatalogSkill(
  db: KobeDb,
  input: {
    readonly teamId: string;
    readonly skillId: string;
    readonly userId: string;
    readonly reason?: string;
  },
): Promise<UninstallResult> {
  const { teamId, skillId } = input;
  return withTeam(db, teamId, async (tx): Promise<UninstallResult> => {
    await lockDefaultSet(tx, "shared");
    await lockInstall(tx, teamId, skillId);
    const removed = await tx.execute<{ origin: "team" | "default_tag"; name: string }>(sql`
      DELETE FROM team_skill_installs i USING registry_skills s
      WHERE i.team_id = ${teamId} AND i.skill_id = ${skillId} AND s.id = i.skill_id
      RETURNING i.origin, s.name`);
    const row = removed.rows[0];
    if (!row) return { ok: false, code: "not_found" };
    const optedOut = await isDefaultSkill(tx, skillId);
    if (optedOut)
      await tx.execute(sql`
        INSERT INTO team_skill_optouts (team_id, skill_id, opted_out_by, reason)
        VALUES (${teamId}, ${skillId}, ${input.userId}, ${input.reason ?? null})
        ON CONFLICT (team_id, skill_id) DO NOTHING`);
    await recordAudit(tx, {
      action: "skill.catalog.removed",
      teamId,
      target: {
        skillId,
        name: row.name,
        origin: row.origin,
        optedOut,
        reasonGiven: optedOut && input.reason !== undefined,
      },
    });
    return { ok: true, optedOut };
  });
}

export type ReinstallResult =
  | { readonly ok: true; readonly semver: string }
  | { readonly ok: false; readonly code: "not_found" | "no_version" };

/**
 * Reinstalls a removed default (SK7): clears the team's opt-out and installs the skill as the
 * Default would (On by default, Track within major, origin `default_tag`). Audited.
 */
export async function reinstallDefault(
  db: KobeDb,
  input: { readonly teamId: string; readonly skillId: string; readonly userId: string },
): Promise<ReinstallResult> {
  const { teamId, skillId } = input;
  return withTeam(db, teamId, async (tx): Promise<ReinstallResult> => {
    await lockDefaultSet(tx, "shared");
    const [target] = await defaultTargets(tx, skillId);
    const optout = await tx.execute(sql`
      SELECT 1 FROM team_skill_optouts WHERE team_id = ${teamId} AND skill_id = ${skillId}`);
    if (!target || optout.rows.length === 0) return { ok: false, code: "not_found" };
    const version = await defaultVersion(tx, target);
    if (!version) return { ok: false, code: "no_version" };
    await lockInstall(tx, teamId, skillId);
    await tx.execute(sql`
      DELETE FROM team_skill_optouts WHERE team_id = ${teamId} AND skill_id = ${skillId}`);
    // The install names the Team admin who brought it back.
    await addInTeam(tx, teamId, skillId, version, input.userId);
    await recordAudit(tx, {
      action: "skill.default.restored",
      teamId,
      target: { skillId, name: target.name, semver: version.semver },
    });
    return { ok: true, semver: version.semver };
  });
}
