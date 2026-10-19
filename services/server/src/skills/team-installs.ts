import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { addInTeam } from "./default-sync-team.js";
import { installAnswers } from "./install-answers.js";
import { readCatalogSwitches } from "./settings.js";
import { requiredCount } from "./access.js";
import { publishedVersions, runningVersion } from "./install-versions.js";
import { compareSemver } from "./semver.js";
import { retirementOf, skillStanding, type Retirement } from "./retirement-state.js";
import {
  defaultTargets,
  defaultVersion,
  isDefaultSkill,
  lockDefaultSet,
  lockSkillInstall,
  lockTeamSkillNames,
} from "./default-target.js";

/**
 * A team's catalog installs (KOBE-314, SK6, SK7, SK25): what the team runs from the Catalog, its
 * Removed defaults, and the two Team admin acts this ticket adds: uninstall (on a Default skill it
 * records a sticky opt-out) and Reinstall of a removed default (clears the opt-out).
 */
export interface SkillInstallRow {
  readonly skillId: string;
  readonly name: string;
  readonly versionId: string;
  readonly semver: string;
  readonly pinMode: "pinned" | "within_major" | "latest";
  readonly access: "available" | "default_on" | "required" | "hidden";
  readonly origin: "team" | "default_tag";
  /** Null when Kobe's own Default sync installed it (KOBE-317). */
  readonly installedBy: string | null;
  readonly updatedAt: string;
  /** The skill carries the Default tag (the "Site default" badge). */
  readonly isDefault: boolean;
  /**
   * A Roll back or a Move pin to an older version switched this tracking install to Pinned
   * (review-337 M1), and nothing changed it since: the console says so until tracking is back.
   */
  readonly pinnedBy: "rollback" | "move" | null;
  /** A retirement the install shows (KOBE-340, SK31): "Revoked — choose a version" and so on. */
  readonly retirement: Retirement | null;
}

export interface RemovedDefault {
  readonly skillId: string;
  readonly name: string;
  readonly optedOutBy: string;
  readonly reason: string | null;
  readonly at: string;
}

/**
 * What a Builder may do with an install (SK25, SK31, review N1 of KOBE-316): only while the team
 * allows Builder installs; never Required and never a deprecated version; and change only an
 * install a Builder or member made. A Default install (it would stop following the Default's
 * majors), a Required one, and one a Team admin made (or someone no longer in the team) are the
 * Team admins' to change. Team admins may change every install.
 */
async function builderMay(
  tx: KobeTx,
  teamId: string,
  access: SkillInstallRow["access"],
  state: string,
  previous: { access: string; origin: string; by_admin: boolean } | undefined,
): Promise<boolean> {
  const { buildersMayInstall } = await readCatalogSwitches(tx, teamId);
  if (!buildersMayInstall || access === "required" || state === "deprecated") return false;
  if (!previous) return true;
  return previous.access !== "required" && previous.origin !== "default_tag" && !previous.by_admin;
}

/** One of the team's own unarchived skills has this name (SK27's name-clash rule). */
async function hasOwnSkillNamed(tx: KobeTx, teamId: string, name: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM team_skills WHERE team_id = ${teamId} AND slug = ${name} AND archived_at IS NULL`);
  return rows.length > 0;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

export async function listTeamSkillInstalls(
  db: KobeDb,
  teamId: string,
): Promise<{ installs: SkillInstallRow[]; removedDefaults: RemovedDefault[] }> {
  return withTeam(db, teamId, async (tx) => {
    const installs = await tx.execute<Record<string, unknown>>(sql`
      SELECT i.skill_id, s.name, i.version_id, v.semver, i.pin_mode, i.access, i.origin,
        i.installed_by, i.updated_at,
        EXISTS (SELECT 1 FROM registry_skill_tags st JOIN registry_tags t ON t.id = st.tag_id
          WHERE st.skill_id = i.skill_id AND t.kind = 'system' AND t.name = 'default') AS is_default,
        (SELECT CASE WHEN a.action = 'skill.catalog.rolled_back' THEN 'rollback' ELSE 'move' END
           FROM audit_log a
          WHERE a.team_id = i.team_id AND a.target ->> 'skillId' = i.skill_id::text
            AND a.action IN ('skill.catalog.configured', 'skill.catalog.pin_moved',
                             'skill.catalog.rolled_back')
          ORDER BY a.seq DESC LIMIT 1
          ) AS last_act,
        (SELECT a.target ? 'pinModeFrom' FROM audit_log a
          WHERE a.team_id = i.team_id AND a.target ->> 'skillId' = i.skill_id::text
            AND a.action IN ('skill.catalog.configured', 'skill.catalog.pin_moved',
                             'skill.catalog.rolled_back')
          ORDER BY a.seq DESC LIMIT 1) AS pinned_by_act
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
    const retirements = new Map<string, Retirement | null>();
    for (const r of installs.rows) {
      const skillId = String(r.skill_id);
      const versions = await publishedVersions(tx, skillId);
      retirements.set(
        skillId,
        retirementOf(
          versions,
          { pinMode: r.pin_mode as SkillInstallRow["pinMode"], versionId: String(r.version_id) },
          await skillStanding(tx, skillId),
        ),
      );
    }
    return {
      installs: installs.rows.map((r) => ({
        skillId: String(r.skill_id),
        name: String(r.name),
        versionId: String(r.version_id),
        semver: String(r.semver),
        pinMode: r.pin_mode as SkillInstallRow["pinMode"],
        access: r.access as SkillInstallRow["access"],
        origin: r.origin as SkillInstallRow["origin"],
        installedBy: r.installed_by === null ? null : String(r.installed_by),
        updatedAt: iso(r.updated_at),
        isDefault: Boolean(r.is_default),
        pinnedBy:
          r.pin_mode === "pinned" && r.pinned_by_act === true
            ? (r.last_act as "rollback" | "move")
            : null,
        retirement: retirements.get(String(r.skill_id)) ?? null,
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
    await lockSkillInstall(tx, teamId, skillId);
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
  | { readonly ok: false; readonly code: "not_found" | "no_version" | "blocked" | "name_clash" };

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
    // The install lock before any read: two concurrent Reinstalls run one after the other.
    await lockSkillInstall(tx, teamId, skillId);
    await lockTeamSkillNames(tx, teamId);
    const [target] = await defaultTargets(tx, skillId);
    const optout = await tx.execute(sql`
      SELECT 1 FROM team_skill_optouts WHERE team_id = ${teamId} AND skill_id = ${skillId}`);
    if (!target || optout.rows.length === 0) return { ok: false, code: "not_found" };
    const blocked = await tx.execute(sql`
      SELECT 1 FROM team_skill_blocks WHERE team_id = ${teamId} AND skill_id = ${skillId}`);
    if (blocked.rows.length > 0) return { ok: false, code: "blocked" };
    if (await hasOwnSkillNamed(tx, teamId, target.name)) return { ok: false, code: "name_clash" };
    const version = await defaultVersion(tx, target);
    if (!version) return { ok: false, code: "no_version" };
    await tx.execute(sql`
      DELETE FROM team_skill_optouts WHERE team_id = ${teamId} AND skill_id = ${skillId}`);
    // The install names the Team admin who brought it back.
    await addInTeam(tx, teamId, skillId, version, input.userId, true);
    await recordAudit(tx, {
      action: "skill.default.restored",
      teamId,
      target: { skillId, name: target.name, semver: version.semver },
    });
    return { ok: true, semver: version.semver };
  });
}

export interface SkillInstallChange {
  readonly pinMode?: SkillInstallRow["pinMode"] | undefined;
  readonly access?: SkillInstallRow["access"] | undefined;
}

/**
 * A team's change to its install's pin mode or access (KOBE-314 review, coordinator decision):
 * any such change marks the install touched (`team_changed_at`), and a touched install never
 * moves with the Default to a new major; the team's choice sticks (SK6). The team install route
 * (a later ticket) changes installs only through this. Returns false when nothing is installed.
 *
 * It has no Builder or Required gate (review N2 of KOBE-316): only a Team admin's act may call it;
 * a Builder path must apply the checks of `installCatalogSkill` (`builderMay`).
 */
export async function changeTeamSkillInstall(
  db: KobeDb,
  teamId: string,
  skillId: string,
  change: SkillInstallChange,
): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    await lockSkillInstall(tx, teamId, skillId);
    const r = await tx.execute(sql`
      UPDATE team_skill_installs SET
        pin_mode = coalesce(${change.pinMode ?? null}::skill_pin_mode, pin_mode),
        access = coalesce(${change.access ?? null}::skill_access, access),
        team_changed_at = now(), updated_at = now()
      WHERE team_id = ${teamId} AND skill_id = ${skillId}
      RETURNING 1`);
    return r.rows.length > 0;
  });
}

export type SkillInstallResult =
  | {
      readonly ok: true;
      readonly semver: string;
      /** The install's pin mode after the change (Pinned after a move back, review-337 M1). */
      readonly pinMode: SkillInstallRow["pinMode"];
      readonly deprecated: boolean;
      /** Required team skills and installs after this change (the console warns from 5). */
      readonly requiredCount: number;
    }
  | {
      readonly ok: false;
      readonly code:
        "not_found" | "no_version" | "not_installable" | "name_clash" | "blocked" | "forbidden";
    };

/**
 * Installs a catalog skill in the team, or changes its install (KOBE-315, SK25): a version by
 * semver (approved; a deprecated one with a warning; never withdrawn, revoked or suspended by a
 * rescan), a pin mode and an access mode. Refused while one of the team's own (unarchived) skills
 * has the same name (SK27: rename or archive it first) and while the team blocks the skill (SK25;
 * Reinstall refuses it the same way). Installing clears a Default opt-out. Any change to an
 * existing install (version, pin mode or access: a Roll back or Move pin too) makes it the team's:
 * touched and origin `team`, so a Default major move never overrides it (SK6). Audited.
 */
export async function installCatalogSkill(
  db: KobeDb,
  input: {
    readonly teamId: string;
    readonly skillId: string;
    readonly userId: string;
    readonly version: string;
    /** Required unless `act` is set: Move pin and Roll back keep the install's own. */
    readonly pinMode?: SkillInstallRow["pinMode"];
    readonly access?: SkillInstallRow["access"];
    /**
     * The caller is a Builder, not a Team admin (SK25): allowed only while the team's switch
     * "Builders may install catalog skills" is on, and never for Required (set or changed) or a
     * deprecated version (the override is the Team admin's, SK31).
     */
    readonly asBuilder?: boolean;
    /**
     * Move pin or Roll back (KOBE-337, SK25): the install's pin mode and access are kept, read
     * under the install's lock (review-337 L4); a move to a version older than what runs switches a
     * tracking install to Pinned, or tracking would run the newer one again (coordinator decision,
     * review-337 M1). Audited with both versions and the mode change, instead of `configured`.
     */
    readonly act?: "move" | "rollback";
  },
): Promise<SkillInstallResult> {
  const { teamId, skillId } = input;
  return withTeam(db, teamId, async (tx): Promise<SkillInstallResult> => {
    await lockDefaultSet(tx, "shared");
    await lockSkillInstall(tx, teamId, skillId);
    // The team's skill-name lock (store.ts uploads take it too): the name-clash checks on both
    // sides see each other's commits (review R-N1).
    await lockTeamSkillNames(tx, teamId);
    const skill = await tx.execute<{ name: string; status: string }>(
      sql`SELECT name, status::text AS status FROM registry_skills WHERE id = ${skillId}`,
    );
    const name = skill.rows[0]?.name;
    if (!name) return { ok: false, code: "not_found" };
    // A deprecated skill (SK31, KOBE-340): every version installs only with a Team admin's warning.
    const skillDeprecated = skill.rows[0]?.status === "deprecated";
    if (await hasOwnSkillNamed(tx, teamId, name)) return { ok: false, code: "name_clash" };
    const blocked = await tx.execute(sql`
      SELECT 1 FROM team_skill_blocks WHERE team_id = ${teamId} AND skill_id = ${skillId}`);
    if (blocked.rows.length > 0) return { ok: false, code: "blocked" };
    const version = await tx.execute<{ id: string; state: string; suspended: boolean }>(sql`
      SELECT id, state::text AS state, suspended_at IS NOT NULL AS suspended
      FROM registry_versions WHERE skill_id = ${skillId} AND semver = ${input.version}`);
    const v = version.rows[0];
    if (!v) return { ok: false, code: "no_version" };
    if ((v.state !== "approved" && v.state !== "deprecated") || v.suspended)
      return { ok: false, code: "not_installable" };
    // A version on the site blocklist never loads, so it is never installed (review-337 L3).
    const versions = await publishedVersions(tx, skillId);
    if (versions.find((x) => x.id === v.id)?.blocklisted)
      return { ok: false, code: "not_installable" };
    const before = await tx.execute<{
      semver: string;
      pin_mode: string;
      access: string;
      origin: string;
      by_admin: boolean;
    }>(sql`
      SELECT rv.semver, i.pin_mode::text AS pin_mode, i.access::text AS access,
        i.origin::text AS origin,
        coalesce((SELECT m.role = 'team_admin' FROM team_members m
                   WHERE m.team_id = i.team_id AND m.user_id = i.installed_by), true) AS by_admin
      FROM team_skill_installs i JOIN registry_versions rv ON rv.id = i.version_id
      WHERE i.team_id = ${teamId} AND i.skill_id = ${skillId}`);
    const previous = before.rows[0];
    if (input.act && !previous) return { ok: false, code: "not_found" };
    const prevPin = previous?.pin_mode as SkillInstallRow["pinMode"] | undefined;
    const access = input.act ? (previous?.access as SkillInstallRow["access"]) : input.access;
    let pinMode = input.act ? prevPin : input.pinMode;
    if (!pinMode || !access) return { ok: false, code: "no_version" };
    // What runs now, and whether the move goes back past it (review-337 M1).
    const prevVersion = previous ? versions.find((x) => x.semver === previous.semver) : undefined;
    const runningFrom =
      previous && prevPin && prevVersion
        ? runningVersion(versions, { pinMode: prevPin, versionId: prevVersion.id })
        : null;
    if (
      input.act &&
      pinMode !== "pinned" &&
      runningFrom &&
      compareSemver(input.version, runningFrom.semver) < 0
    )
      pinMode = "pinned";
    const deprecated = v.state === "deprecated" || skillDeprecated;
    if (
      input.asBuilder &&
      !(await builderMay(tx, teamId, access, deprecated ? "deprecated" : v.state, previous))
    )
      return { ok: false, code: "forbidden" };
    const changed = sql`(team_skill_installs.version_id <> EXCLUDED.version_id
      OR team_skill_installs.pin_mode <> EXCLUDED.pin_mode
      OR team_skill_installs.access <> EXCLUDED.access)`;
    await tx.execute(sql`
      INSERT INTO team_skill_installs
        (team_id, skill_id, version_id, pin_mode, access, origin, installed_by)
      VALUES (${teamId}, ${skillId}, ${v.id}, ${pinMode}::skill_pin_mode,
        ${access}::skill_access, 'team', ${input.userId})
      ON CONFLICT (team_id, skill_id) DO UPDATE SET
        version_id = EXCLUDED.version_id, updated_at = now(),
        pin_mode = EXCLUDED.pin_mode, access = EXCLUDED.access,
        origin = CASE WHEN ${changed} THEN 'team' ELSE team_skill_installs.origin END,
        team_changed_at = CASE WHEN ${changed} THEN now()
          ELSE team_skill_installs.team_changed_at END`);
    await tx.execute(sql`
      DELETE FROM team_skill_optouts WHERE team_id = ${teamId} AND skill_id = ${skillId}`);
    if (!previous) await installAnswers(tx, teamId, skillId);
    if (input.act && previous)
      await recordAudit(tx, {
        action: input.act === "move" ? "skill.catalog.pin_moved" : "skill.catalog.rolled_back",
        teamId,
        target: {
          skillId,
          name,
          from: previous.semver,
          to: input.version,
          pinMode,
          ...(prevPin && prevPin !== "pinned" && pinMode === "pinned"
            ? { pinModeFrom: prevPin }
            : {}),
          runningFrom: runningFrom?.semver ?? null,
          runningTo: runningVersion(versions, { pinMode, versionId: v.id })?.semver ?? null,
          deprecated,
        },
      });
    else
      await recordAudit(tx, {
        action: "skill.catalog.configured",
        teamId,
        target: {
          skillId,
          name,
          semver: input.version,
          pinMode,
          access,
          deprecated,
          ...(previous
            ? {
                previous: {
                  semver: previous.semver,
                  pinMode: previous.pin_mode as SkillInstallRow["pinMode"],
                  access: previous.access as SkillInstallRow["access"],
                },
              }
            : {}),
        },
      });
    return {
      ok: true,
      pinMode,
      semver: input.version,
      deprecated,
      requiredCount: await requiredCount(tx, teamId),
    };
  });
}
