import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { logger } from "../logger.js";
import { CONSOLE_PATHS } from "../mail/console-paths.js";
import type { Mailer } from "../mail/mailer.js";
import { oneLine } from "../mail/messages.js";

/**
 * Request for team (KOBE-338, SK25): a member asks the team's admins to install a catalog skill.
 * The request is the team's own audit row (`skill.catalog.team_requested`), so it needs no table
 * of its own: the Team console lists the skills asked for in the last {@link REQUEST_WINDOW_DAYS}
 * days, since the last dismissal, that the team has neither installed nor blocked. A member asks
 * at most once a day per skill (a repeat answers `alreadyRequested` and emails no one).
 *
 * The admins are emailed after the request commits, off the request path, best effort like the
 * Registry's review emails: the console list is the durable record, so a lost email loses nothing.
 * The email names the requester, the skill and the team; nothing else.
 */
export const REQUEST_WINDOW_DAYS = 30;
const REPEAT_HOURS = 24;

export type RequestResult =
  | { readonly ok: true; readonly alreadyRequested: boolean; readonly name: string }
  | { readonly ok: false; readonly code: "not_found" | "installed" | "blocked" };

export interface InstallRequest {
  readonly skillId: string;
  readonly name: string;
  /** Members who asked (distinct), newest first. */
  readonly requesters: readonly { readonly userId: string; readonly name: string }[];
  readonly count: number;
  readonly lastAt: string;
}

/** Requests for one skill (or every skill) that are still open: after the last dismissal. */
const OPEN = (teamId: string, skillId?: string) => sql`
  SELECT a.target ->> 'skillId' AS skill_id, a.actor_id, a.at
    FROM audit_log a
   WHERE a.team_id = ${teamId} AND a.action = 'skill.catalog.team_requested'
     AND a.at > now() - make_interval(days => ${REQUEST_WINDOW_DAYS})
     ${skillId ? sql`AND a.target ->> 'skillId' = ${skillId}` : sql``}
     AND NOT EXISTS (SELECT 1 FROM audit_log d
       WHERE d.team_id = a.team_id AND d.action = 'skill.catalog.team_request_dismissed'
         AND d.target ->> 'skillId' = a.target ->> 'skillId' AND d.seq > a.seq)`;

async function skillStanding(
  tx: KobeTx,
  teamId: string,
  skillId: string,
): Promise<{ name: string; installed: boolean; blocked: boolean } | null> {
  // Only what the Catalog tab shows: a live skill with an approved, unsuspended version.
  const { rows } = await tx.execute<{ name: string; installed: boolean; blocked: boolean }>(sql`
    SELECT s.name,
      EXISTS (SELECT 1 FROM team_skill_installs i
               WHERE i.team_id = ${teamId} AND i.skill_id = s.id) AS installed,
      EXISTS (SELECT 1 FROM team_skill_blocks b
               WHERE b.team_id = ${teamId} AND b.skill_id = s.id) AS blocked
      FROM registry_skills s
     WHERE s.id = ${skillId} AND s.status <> 'archived'
       AND EXISTS (SELECT 1 FROM registry_versions v WHERE v.skill_id = s.id
                    AND v.state = 'approved' AND v.suspended_at IS NULL)`);
  return rows[0] ?? null;
}

export function requestForTeam(
  db: KobeDb,
  input: { readonly teamId: string; readonly userId: string; readonly skillId: string },
): Promise<RequestResult> {
  const { teamId, userId, skillId } = input;
  return withTeam(db, teamId, async (tx): Promise<RequestResult> => {
    const key = `kobe.skills.install-request:${teamId}:${userId}:${skillId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const skill = await skillStanding(tx, teamId, skillId);
    if (!skill) return { ok: false, code: "not_found" };
    if (skill.installed) return { ok: false, code: "installed" };
    if (skill.blocked) return { ok: false, code: "blocked" };
    const recent = await tx.execute(sql`
      SELECT 1 FROM (${OPEN(teamId, skillId)}) r
       WHERE r.actor_id = ${userId} AND r.at > now() - make_interval(hours => ${REPEAT_HOURS})`);
    if (recent.rows.length > 0) return { ok: true, alreadyRequested: true, name: skill.name };
    await recordAudit(tx, {
      action: "skill.catalog.team_requested",
      teamId,
      target: { skillId, name: skill.name },
    });
    return { ok: true, alreadyRequested: false, name: skill.name };
  });
}

/** The open requests, per skill, for skills the team has neither installed nor blocked. */
export function listInstallRequests(db: KobeDb, teamId: string): Promise<InstallRequest[]> {
  return withTeam(db, teamId, async (tx) => {
    const { rows } = await tx.execute<{
      skill_id: string;
      name: string;
      requesters: { userId: string; name: string }[];
      count: number;
      last_at: Date;
    }>(sql`
      WITH open AS (${OPEN(teamId)}),
      per_user AS (
        SELECT skill_id, actor_id, max(at) AS at FROM open GROUP BY skill_id, actor_id)
      SELECT p.skill_id, s.name, count(*)::int AS count, max(p.at) AS last_at,
        jsonb_agg(jsonb_build_object('userId', u.id, 'name', u.name) ORDER BY p.at DESC)
          AS requesters
        FROM per_user p
        JOIN registry_skills s ON s.id = p.skill_id::uuid
        JOIN users u ON u.id = p.actor_id
       WHERE NOT EXISTS (SELECT 1 FROM team_skill_installs i
                          WHERE i.team_id = ${teamId} AND i.skill_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM team_skill_blocks b
                          WHERE b.team_id = ${teamId} AND b.skill_id = s.id)
       GROUP BY p.skill_id, s.name
       ORDER BY max(p.at) DESC`);
    return rows.map((r) => ({
      skillId: r.skill_id,
      name: r.name,
      requesters: r.requesters,
      count: Number(r.count),
      lastAt: r.last_at instanceof Date ? r.last_at.toISOString() : String(r.last_at),
    }));
  });
}

/** Dismisses the open requests for a skill (they leave the list until someone asks again). */
export function dismissInstallRequests(
  db: KobeDb,
  input: { readonly teamId: string; readonly skillId: string },
): Promise<boolean> {
  const { teamId, skillId } = input;
  return withTeam(db, teamId, async (tx) => {
    const open = await tx.execute<{ name: string; n: number }>(sql`
      SELECT s.name, count(*)::int AS n FROM (${OPEN(teamId, skillId)}) r
        JOIN registry_skills s ON s.id = r.skill_id::uuid GROUP BY s.name`);
    const row = open.rows[0];
    if (!row) return false;
    await recordAudit(tx, {
      action: "skill.catalog.team_request_dismissed",
      teamId,
      target: { skillId, name: row.name, requests: Number(row.n) },
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
  request: { readonly teamId: string; readonly userId: string; readonly skill: string },
): Promise<void> {
  const { teamId } = request;
  const found = await withTeam(deps.db, teamId, async (tx) => {
    const team = await tx.execute<{ name: string; requester: string }>(sql`
      SELECT t.name, u.name AS requester FROM teams t, users u
       WHERE t.id = ${teamId} AND u.id = ${request.userId}`);
    const admins = await tx.execute<{ email: string }>(sql`
      SELECT u.email FROM team_members m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ${teamId} AND m.role = 'team_admin' AND u.deactivated_at IS NULL`);
    return { team: team.rows[0], admins: admins.rows };
  });
  if (!found.team) return;
  const team = oneLine(found.team.name, 64);
  const skill = oneLine(request.skill, 64);
  const text = [
    `${oneLine(found.team.requester, 64)} asked to install the catalog skill ${skill} for the ${team} team on Kobe.`,
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
