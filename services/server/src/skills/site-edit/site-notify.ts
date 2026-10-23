import { sql, withTeam, type KobeDb } from "@kobe/db";
import type { Published } from "./site-publish.js";

/**
 * A Site admin's new version of a team-published skill (KOBE-495): the skill's maintainers who
 * belong to the publishing team (the team its newest maintainer version came from) get an in-app
 * notice naming the version and the admin (`skill.version.site_published`). Written after the
 * version commits, under that team's RLS; best effort (the catalog and the audit log are the
 * record). Returns how many were told.
 */
export async function notifyMaintainers(
  db: KobeDb,
  published: Published,
  adminId: string,
): Promise<number> {
  const teamId = published.notifyTeamId;
  if (!teamId) return 0;
  return withTeam(db, teamId, async (tx) => {
    const { rows } = await tx.execute<{ user_id: string }>(sql`
      INSERT INTO notifications (team_id, user_id, kind, skill_id, skill_semver, actor_user_id)
      SELECT ${teamId}, m.user_id, 'skill.version.site_published', ${published.skillId},
        ${published.semver}, ${adminId}
        FROM registry_maintainers m
        JOIN team_members tm ON tm.team_id = ${teamId} AND tm.user_id = m.user_id
        JOIN users u ON u.id = m.user_id AND u.deactivated_at IS NULL
       WHERE m.skill_id = ${published.skillId}
      RETURNING user_id`);
    return rows.length;
  });
}
