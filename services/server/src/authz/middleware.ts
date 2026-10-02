import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { eq, getMembership, sessionActiveTeams, teams, type TeamRole } from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import type { ServerDeps } from "../deps.js";
import {
  installRoleAllows,
  teamRoleAllows,
  type InstallPermission,
  type TeamPermission,
} from "./permissions.js";

/** Header naming the team the client believes is active (multi-tab guard); required on changes. */
export const TEAM_HEADER = "x-kobe-team";

export interface ActiveTeam {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** The caller's role in this team, verified for this request. */
  readonly role: TeamRole;
}

export interface TeamVariables extends AuthVariables {
  team: ActiveTeam;
}

const uuid = z.uuid();
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** 403 unless the caller's install role holds `permission`. Runs after requireSession. */
export function requireInstallPermission(permission: InstallPermission) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (!installRoleAllows(c.get("installRole"), permission)) {
      return c.json({ code: "forbidden", message: "You don't have permission to do that." }, 403);
    }
    await next();
  });
}

/** The session's active team pointer (spec D9), or null. */
export async function readActiveTeamId(
  deps: ServerDeps,
  sessionId: string,
): Promise<string | null> {
  const [row] = await deps.database.db
    .select({ teamId: sessionActiveTeams.teamId })
    .from(sessionActiveTeams)
    .where(eq(sessionActiveTeams.sessionId, sessionId));
  return row?.teamId ?? null;
}

/**
 * Resolves exactly one team for the request from the session's active team (spec D9) and
 * re-verifies membership under that team's RLS on every request, so removal takes effect at once.
 * Install roles grant nothing here: an install admin who is not a member is refused like anyone.
 * Handlers run their team queries with `withTeam(db, c.var.team.id, ...)`.
 */
export function requireTeam(deps: ServerDeps) {
  return createMiddleware<{ Variables: TeamVariables }>(async (c, next) => {
    const claimed = c.req.header(TEAM_HEADER);
    // Changes must name the team the client is acting on, so a stale tab can't write to the team
    // another tab switched to. Reads may omit it (the web client always sends it).
    if (claimed === undefined && !SAFE_METHODS.has(c.req.method)) {
      return c.json(
        { code: "team_header_required", message: `Send ${TEAM_HEADER} with team changes.` },
        400,
      );
    }
    if (claimed !== undefined && !uuid.safeParse(claimed).success) {
      return c.json({ code: "invalid_request", message: `${TEAM_HEADER} must be a team id.` }, 400);
    }
    const [active] = await deps.database.db
      .select({ id: teams.id, slug: teams.slug, name: teams.name })
      .from(sessionActiveTeams)
      .innerJoin(teams, eq(teams.id, sessionActiveTeams.teamId))
      .where(eq(sessionActiveTeams.sessionId, c.get("sessionId")));
    if (!active) {
      return c.json({ code: "no_active_team", message: "Choose a team first." }, 409);
    }
    if (claimed !== undefined && claimed !== active.id) {
      return c.json(
        {
          code: "team_mismatch",
          message: "Your active team changed in another tab. Reload to continue.",
          activeTeamId: active.id,
        },
        409,
      );
    }
    const role = await getMembership(deps.database.db, active.id, c.get("user").id);
    if (role === null) {
      return c.json(
        { code: "not_a_team_member", message: "You are no longer a member of this team." },
        403,
      );
    }
    c.set("team", { ...active, role });
    await next();
  });
}

/** 403 unless the caller's role in the active team holds `permission`. Runs after requireTeam. */
export function requireTeamPermission(permission: TeamPermission) {
  return createMiddleware<{ Variables: TeamVariables }>(async (c, next) => {
    if (!teamRoleAllows(c.get("team").role, permission)) {
      return c.json({ code: "forbidden", message: "Your team role doesn't allow that." }, 403);
    }
    await next();
  });
}
