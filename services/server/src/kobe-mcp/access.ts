import {
  KOBE_BUILTIN_CONNECTOR_ID,
  parseKobeMcpMode,
  parseKobeMcpTeamLevel,
  sql,
  KOBE_MCP_MODE_KEY,
  type KobeMcpMode,
  type KobeMcpTeamLevel,
  type KobeTx,
  type TeamRole,
} from "@kobe/db";
import { siteRoleAllows, teamRoleAllows, type SiteRole } from "../authz/permissions.js";
import type { KobeTool } from "./catalog.js";
import { KOBE_ADMIN_TOOLS } from "./tools/index.js";

/**
 * Who may use which Kobe MCP tool right now (KOBE-619, spec kobe-admin-mcp §3, §6, §8): the site
 * switch (`kobe_mcp.mode`), the team's level (`teams.settings.kobe_mcp.admin`) and the person's
 * own permission (team role, site role), all re-read from the database for every list and call.
 */

/** Anything with `execute` (a pool or a transaction): every read here is a plain statement. */
type Reader = Pick<KobeTx, "execute">;

export interface KobeBuiltinRow {
  readonly id: string;
  readonly name: string;
}

export interface KobeAccess {
  readonly mode: KobeMcpMode;
  readonly level: KobeMcpTeamLevel;
  /** The person's role in the team; null when no longer a member. */
  readonly teamRole: TeamRole | null;
  readonly siteRole: SiteRole;
}

/** The seeded `kobe` row while it is active and the site switch is not `off`. */
export async function loadKobeBuiltin(db: Reader): Promise<KobeBuiltinRow | undefined> {
  const res = await db.execute<{ id: string; name: string; mode: string | null }>(sql`
    SELECT c.id, c.name,
           (SELECT s.value FROM public.site_settings s WHERE s.key = ${KOBE_MCP_MODE_KEY}) AS mode
      FROM public.connectors c
     WHERE c.builtin = 'kobe' AND c.id = ${KOBE_BUILTIN_CONNECTOR_ID}
       AND c.status = 'active' AND c.deleted_at IS NULL`);
  const row = res.rows[0];
  if (row === undefined || parseKobeMcpMode(row.mode) === "off") return undefined;
  return { id: row.id, name: row.name };
}

/** The built-in row's name whatever the switches say (`kobe`, or `kobe-builtin`), if seeded. */
export async function kobeBuiltinName(db: Reader): Promise<string | undefined> {
  const res = await db.execute<{ name: string }>(
    sql`SELECT name FROM public.connectors WHERE builtin = 'kobe'`,
  );
  return res.rows[0]?.name;
}

/** Switches only (no person): the engine's view of the connector in a team. */
export async function loadKobeSwitches(
  db: Reader,
  teamId: string,
): Promise<{ mode: KobeMcpMode; level: KobeMcpTeamLevel }> {
  const res = await db.execute<{ mode: string | null; settings: unknown }>(sql`
    SELECT (SELECT s.value FROM public.site_settings s WHERE s.key = ${KOBE_MCP_MODE_KEY}) AS mode,
           (SELECT t.settings FROM public.teams t WHERE t.id = ${teamId}) AS settings`);
  const row = res.rows[0];
  return { mode: parseKobeMcpMode(row?.mode), level: parseKobeMcpTeamLevel(row?.settings) };
}

/**
 * The switches and the person's roles. `team_members` is a team table: run inside
 * `withTeam(teamId)` (or the role reads as null and nothing is allowed).
 */
export async function loadKobeAccess(
  db: Reader,
  teamId: string,
  userId: string,
): Promise<KobeAccess> {
  const switches = await loadKobeSwitches(db, teamId);
  const res = await db.execute<{ team_role: TeamRole | null; site_role: SiteRole }>(sql`
    SELECT (SELECT m.role FROM public.team_members m
             WHERE m.team_id = ${teamId} AND m.user_id = ${userId}) AS team_role,
           (SELECT r.role FROM public.site_roles r WHERE r.user_id = ${userId}) AS site_role,
           (SELECT u.deactivated_at IS NOT NULL FROM public.users u WHERE u.id = ${userId}) AS gone`);
  const row = res.rows[0] as { team_role: TeamRole | null; site_role: SiteRole; gone?: boolean };
  const active = row !== undefined && row.gone === false;
  return {
    ...switches,
    teamRole: active ? row.team_role : null,
    siteRole: active ? (row.site_role ?? null) : null,
  };
}

/** The site and team switches allow the tool (KA5: admin tools only with `admin` + a level). */
export function switchesAllow(
  tool: KobeTool,
  switches: { readonly mode: KobeMcpMode; readonly level: KobeMcpTeamLevel },
): boolean {
  if (switches.mode !== "admin") return false;
  if (switches.level === "read") return tool.readOnly;
  return switches.level === "read_write";
}

/** The person holds the tool's console permission (and is still a member of the team). */
export function personAllows(tool: KobeTool, access: KobeAccess): boolean {
  if (access.teamRole === null) return false;
  return tool.scope === "team"
    ? teamRoleAllows(access.teamRole, tool.permission)
    : siteRoleAllows(access.siteRole, tool.permission);
}

/** The tools this person may list and call now. */
export function allowedKobeTools(access: KobeAccess): KobeTool[] {
  return KOBE_ADMIN_TOOLS.filter((t) => switchesAllow(t, access) && personAllows(t, access));
}
