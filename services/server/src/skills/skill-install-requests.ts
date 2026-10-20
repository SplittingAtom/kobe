import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { logger } from "../logger.js";
import { CONSOLE_PATHS } from "../mail/console-paths.js";
import type { Mailer } from "../mail/mailer.js";
import { oneLine } from "../mail/messages.js";
import { lockSkillInstall } from "./default-target.js";

/**
 * Request for team (KOBE-338, SK25): a member asks the team's admins to install a catalog skill,
 * or, once it is installed, to change the install (another version or pin; the install governs
 * and members can't add it for themselves, review M3).
 * Requests are live team state in `team_skill_requests` (one row per member and skill, forced RLS;
 * review D1); the audit log keeps who asked (`skill.catalog.team_requested`) and who dismissed.
 *
 * Limits (review M1, M2): a member asks for a skill at most once a day (counted from the last time
 * they asked, whether or not a Team admin dismissed it since), and for at most
 * {@link REQUESTS_PER_DAY} skills a day. Installing (newly) or blocking the skill answers its requests
 * (`skillInstallAnswers`, `blockCatalogSkill`); they leave with the membership (cascade).
 *
 * The admins are emailed after the request commits, off the request path, best effort: the console
 * list is the durable record.
 */
export const REQUEST_WINDOW_DAYS = 30;
/** Different skills one member may ask for in a day (review M2). */
export const REQUESTS_PER_DAY = 5;

export type RequestResult =
  | {
      readonly ok: true;
      readonly alreadyRequested: boolean;
      readonly name: string;
      /** The version the team's install is pinned at, when it has one (a request for a change). */
      readonly installed: string | null;
    }
  | { readonly ok: false; readonly code: "not_found" | "blocked" | "request_limit" };

export interface SkillInstallRequest {
  readonly skillId: string;
  readonly name: string;
  /** Members who asked, newest first. */
  readonly requesters: readonly { readonly userId: string; readonly name: string }[];
  readonly count: number;
  readonly lastAt: string;
  /** The team's install's version: the members ask for a change (another version or pin). */
  readonly installed: string | null;
}

async function skillStanding(
  tx: KobeTx,
  teamId: string,
  skillId: string,
): Promise<{ name: string; installed: string | null; blocked: boolean } | null> {
  // Only what the Catalog tab shows: a live skill with an approved, unsuspended version.
  const { rows } = await tx.execute<{ name: string; installed: string | null; blocked: boolean }>(
    sql`
    SELECT s.name,
      (SELECT v.semver FROM team_skill_installs i JOIN registry_versions v ON v.id = i.version_id
        WHERE i.team_id = ${teamId} AND i.skill_id = s.id) AS installed,
      EXISTS (SELECT 1 FROM team_skill_blocks b
               WHERE b.team_id = ${teamId} AND b.skill_id = s.id) AS blocked
      FROM registry_skills s
     WHERE s.id = ${skillId} AND s.status <> 'archived'
       AND EXISTS (SELECT 1 FROM registry_versions v WHERE v.skill_id = s.id
                    AND v.state = 'approved' AND v.suspended_at IS NULL)`,
  );
  return rows[0] ?? null;
}

export function requestForTeam(
  db: KobeDb,
  input: { readonly teamId: string; readonly userId: string; readonly skillId: string },
): Promise<RequestResult> {
  const { teamId, userId, skillId } = input;
  return withTeam(db, teamId, async (tx): Promise<RequestResult> => {
    // One member's requests one at a time: the daily cap counts what the others committed.
    const key = `kobe.skills.team-request:${teamId}:${userId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    // The install lock: an install or block answering requests sees this one, or it sees them.
    await lockSkillInstall(tx, teamId, skillId);
    const skill = await skillStanding(tx, teamId, skillId);
    if (!skill) return { ok: false, code: "not_found" };
    if (skill.blocked) return { ok: false, code: "blocked" };
    const today = await tx.execute<{ skill_id: string }>(sql`
      SELECT skill_id FROM team_skill_requests
       WHERE team_id = ${teamId} AND user_id = ${userId} AND last_at > now() - interval '1 day'`);
    if (today.rows.some((r) => r.skill_id === skillId))
      return { ok: true, alreadyRequested: true, name: skill.name, installed: skill.installed };
    if (today.rows.length >= REQUESTS_PER_DAY) return { ok: false, code: "request_limit" };
    await tx.execute(sql`
      INSERT INTO team_skill_requests (team_id, skill_id, user_id)
      VALUES (${teamId}, ${skillId}, ${userId})
      ON CONFLICT (team_id, skill_id, user_id) DO UPDATE
        SET last_at = now(), dismissed_at = NULL`);
    await recordAudit(tx, {
      action: "skill.catalog.team_requested",
      teamId,
      target: { skillId, name: skill.name },
    });
    return { ok: true, alreadyRequested: false, name: skill.name, installed: skill.installed };
  });
}

/**
 * The open requests per skill: not dismissed, from the last {@link REQUEST_WINDOW_DAYS} days, by
 * active members (review L2). Older rows are purged here (live state, not history).
 */
export function listSkillInstallRequests(
  db: KobeDb,
  teamId: string,
): Promise<SkillInstallRequest[]> {
  return withTeam(db, teamId, async (tx) => {
    await tx.execute(sql`
      DELETE FROM team_skill_requests
       WHERE team_id = ${teamId}
         AND last_at < now() - make_interval(days => ${REQUEST_WINDOW_DAYS})`);
    const { rows } = await tx.execute<{
      skill_id: string;
      name: string;
      requesters: { userId: string; name: string }[];
      count: number;
      last_at: string;
      installed: string | null;
    }>(sql`
      SELECT r.skill_id, s.name, count(*)::int AS count,
        to_json(max(r.last_at)) #>> '{}' AS last_at,
        (SELECT v.semver FROM team_skill_installs i JOIN registry_versions v ON v.id = i.version_id
          WHERE i.team_id = r.team_id AND i.skill_id = r.skill_id) AS installed,
        jsonb_agg(jsonb_build_object('userId', u.id, 'name', u.name) ORDER BY r.last_at DESC)
          AS requesters
        FROM team_skill_requests r
        JOIN registry_skills s ON s.id = r.skill_id
        JOIN users u ON u.id = r.user_id AND u.deactivated_at IS NULL
       WHERE r.team_id = ${teamId} AND r.dismissed_at IS NULL
       GROUP BY r.team_id, r.skill_id, s.name
       ORDER BY max(r.last_at) DESC`);
    return rows.map((r) => ({
      skillId: r.skill_id,
      name: r.name,
      requesters: r.requesters,
      count: Number(r.count),
      lastAt: new Date(r.last_at).toISOString(),
      installed: r.installed,
    }));
  });
}

/** Dismisses the open requests for a skill (they leave the list until someone asks again). */
export function dismissSkillInstallRequests(
  db: KobeDb,
  input: { readonly teamId: string; readonly skillId: string },
): Promise<boolean> {
  const { teamId, skillId } = input;
  return withTeam(db, teamId, async (tx) => {
    const dismissed = await tx.execute<{ name: string }>(sql`
      UPDATE team_skill_requests r SET dismissed_at = now()
        FROM registry_skills s
       WHERE r.team_id = ${teamId} AND r.skill_id = ${skillId} AND r.dismissed_at IS NULL
         AND s.id = r.skill_id
      RETURNING s.name`);
    const name = dismissed.rows[0]?.name;
    if (!name) return false;
    await recordAudit(tx, {
      action: "skill.catalog.team_request_dismissed",
      teamId,
      target: { skillId, name, requests: dismissed.rows.length },
    });
    return true;
  });
}

export interface RequestNotifyDeps {
  readonly db: KobeDb;
  readonly mailer: Mailer;
  readonly publicUrl: string;
}

/** Emails the team's active admins about a member's request (after it commits). */
export async function notifyTeamAdmins(
  deps: RequestNotifyDeps,
  request: {
    readonly teamId: string;
    readonly userId: string;
    readonly skill: string;
    readonly installed: string | null;
  },
): Promise<void> {
  const { teamId } = request;
  const found = await withTeam(deps.db, teamId, async (tx) => {
    const team = await tx.execute<{ name: string; requester: string; email: string }>(sql`
      SELECT t.name, u.name AS requester, u.email FROM teams t, users u
       WHERE t.id = ${teamId} AND u.id = ${request.userId}`);
    const admins = await tx.execute<{ email: string }>(sql`
      SELECT u.email FROM team_members m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ${teamId} AND m.role = 'team_admin' AND u.deactivated_at IS NULL`);
    return { team: team.rows[0], admins: admins.rows };
  });
  if (!found.team) return;
  const team = oneLine(found.team.name, 64);
  const skill = oneLine(request.skill, 64);
  // The display name is the member's own free text: quoted, with their address (review L5).
  const who = `"${oneLine(found.team.requester, 64).replaceAll('"', "'")}" <${found.team.email}>, a member of the ${team} team,`;
  const text = [
    request.installed
      ? `${who} asked for a change to the team's install of the catalog skill ${skill} (now ${oneLine(request.installed, 32)}) on Kobe.`
      : `${who} asked to install the catalog skill ${skill} for the team on Kobe.`,
    "",
    `Install it, or dismiss the request, in your team console: ${deps.publicUrl}${CONSOLE_PATHS.teamSkills}`,
  ].join("\n");
  for (const admin of found.admins) {
    try {
      await deps.mailer.send({
        to: admin.email,
        subject: `Skill request: ${skill} for the ${team} team`,
        text,
      });
    } catch (err) {
      logger.warn({ err, teamId }, "skills: install request email failed");
    }
  }
}
