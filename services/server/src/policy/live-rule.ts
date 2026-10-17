import { sql } from "@kobe/db";

/**
 * A user rule still holds: not expired; a `thread` rule's thread exists, is not deleted or
 * archived, is still the member's and is still one they can open (no project, or a project they
 * are a member of, or they are a team admin); a `run` rule's run is still active. References the
 * outer query's `tool_rules` row by table name (no alias).
 */
export function liveUserRule(now: Date) {
  return sql`(
    (tool_rules.expires_at IS NULL OR tool_rules.expires_at > ${now.toISOString()}::timestamptz)
    AND (tool_rules.thread_id IS NULL OR EXISTS (
      SELECT 1 FROM threads t
       WHERE t.team_id = tool_rules.team_id AND t.id = tool_rules.thread_id
         AND t.owner_user_id = tool_rules.user_id
         AND t.deleted_at IS NULL AND t.archived_at IS NULL
         AND (t.project_id IS NULL OR EXISTS (
           SELECT 1 FROM projects p
            WHERE p.team_id = t.team_id AND p.id = t.project_id
              AND (p.members_mode = 'team'
                   OR EXISTS (SELECT 1 FROM project_members m
                               WHERE m.team_id = p.team_id AND m.project_id = p.id
                                 AND m.user_id = tool_rules.user_id)
                   OR EXISTS (SELECT 1 FROM team_members tm
                               WHERE tm.team_id = p.team_id AND tm.user_id = tool_rules.user_id
                                 AND tm.role = 'team_admin'))))))
    AND (tool_rules.run_id IS NULL OR EXISTS (
      SELECT 1 FROM runs u
       WHERE u.team_id = tool_rules.team_id AND u.id = tool_rules.run_id
         AND u.status IN ('running', 'waiting_approval')))
  )`;
}
