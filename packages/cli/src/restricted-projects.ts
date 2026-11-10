import type pg from "pg";
import { serverInfo } from "./catalog.js";

/**
 * `kobe projects restricted` (KOBE-587, projects-in-conversations RV2): the dry-run an admin runs
 * before upgrading to the release that removes restricted project visibility. It lists every
 * restricted project of every team with its explicit members, so the admin sees what becomes
 * visible to the whole workspace (and which reader rows the migration deletes). Read-only: one
 * `READ ONLY` transaction, and it works on a database that has not run the migration yet.
 */

export interface RestrictedProjectMember {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly role: string;
}

export interface RestrictedProject {
  readonly teamId: string;
  readonly teamSlug: string;
  readonly teamName: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly archived: boolean;
  readonly members: readonly RestrictedProjectMember[];
}

/** `pending`: the migration has not run (projects listed); `migrated`: nothing is restricted any more. */
export interface RestrictedProjectsReport {
  readonly state: "pending" | "migrated";
  readonly projects: readonly RestrictedProject[];
}

const ROLE_ORDER = `CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END`;

async function hasVisibility(client: pg.ClientBase): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'projects'
                       AND column_name = 'visibility') AS present`,
  );
  return rows[0]?.present === true;
}

async function readProjects(client: pg.ClientBase): Promise<RestrictedProject[]> {
  const { rows: projects } = await client.query<{
    team_id: string;
    team_slug: string;
    team_name: string;
    id: string;
    slug: string;
    name: string;
    archived: boolean;
  }>(
    `SELECT p.team_id, t.slug AS team_slug, t.name AS team_name, p.id, p.slug, p.name,
            p.archived_at IS NOT NULL AS archived
       FROM projects p JOIN teams t ON t.id = p.team_id
      WHERE p.visibility = 'restricted'
      ORDER BY t.slug, p.slug`,
  );
  const { rows: members } = await client.query<{
    team_id: string;
    project_id: string;
    user_id: string;
    email: string;
    name: string;
    role: string;
  }>(
    `SELECT m.team_id, m.project_id, m.user_id, u.email, u.name, m.role
       FROM project_members m
       JOIN projects p ON p.team_id = m.team_id AND p.id = m.project_id
       JOIN users u ON u.id = m.user_id
      WHERE p.visibility = 'restricted'
      ORDER BY ${ROLE_ORDER}, u.email`,
  );
  return projects.map((p) => ({
    teamId: p.team_id,
    teamSlug: p.team_slug,
    teamName: p.team_name,
    projectId: p.id,
    projectSlug: p.slug,
    projectName: p.name,
    archived: p.archived,
    members: members
      .filter((m) => m.team_id === p.team_id && m.project_id === p.id)
      .map((m) => ({ userId: m.user_id, email: m.email, name: m.name, role: m.role })),
  }));
}

/**
 * Lists the restricted projects. The role must read every team's rows (superuser or BYPASSRLS,
 * as `kobe backup`): under FORCE ROW LEVEL SECURITY any other role would see none and report a
 * misleading empty list, so it is refused.
 */
export async function listRestrictedProjects(
  client: pg.ClientBase,
): Promise<RestrictedProjectsReport> {
  const info = await serverInfo(client);
  if (!info.superuser && !info.bypassRls) {
    throw new Error(
      `Refusing to list as "${info.user}": the role is bound by row-level security, so it would see no team's projects. Use the backup role (BYPASSRLS, see docs/backup-restore.md)`,
    );
  }
  await client.query("BEGIN READ ONLY");
  try {
    const report: RestrictedProjectsReport = (await hasVisibility(client))
      ? { state: "pending", projects: await readProjects(client) }
      : { state: "migrated", projects: [] };
    return report;
  } finally {
    await client.query("ROLLBACK");
  }
}

function memberLine(m: RestrictedProjectMember): string {
  const note = m.role === "reader" ? "  [row deleted]" : "";
  return `    ${m.role.padEnd(7)} ${m.email} (${m.name})${note}`;
}

/** Plain text for the operator: one block per project, members with their roles. */
export function formatRestrictedProjects(report: RestrictedProjectsReport): string {
  if (report.state === "migrated") {
    return "No restricted projects: this database already ran the migration that removed restricted visibility (KOBE-587).";
  }
  if (report.projects.length === 0) {
    return "No restricted projects: the upgrade changes no project's visibility.";
  }
  const n = report.projects.length;
  const lines = [
    `${n} restricted project${n === 1 ? "" : "s"}. After the upgrade each one is readable by every member of its workspace;`,
    "owners and editors keep their roles, explicit reader rows are deleted (every member reads anyway).",
    "",
  ];
  for (const p of report.projects) {
    lines.push(
      `${p.teamSlug} (${p.teamName}) / ${p.projectSlug}: ${p.projectName}${p.archived ? " (archived)" : ""}`,
    );
    if (p.members.length === 0) lines.push("    (no explicit members)");
    else lines.push(...p.members.map(memberLine));
  }
  return lines.join("\n");
}
