/** Who the caller is to each console, as the server says (never cached client state). */
import { apiRequest, type ApiResult } from "../../api/client";
import type { TeamRole } from "../../teams";
import type { CurrentUser, SiteAccess, SiteGrant, SiteRole, TeamAccess } from "../nav/types";

interface MeBody {
  readonly user: CurrentUser;
  readonly siteRole: "owner" | "admin" | null;
  readonly siteGrants?: readonly string[];
}

const SITE_GRANTS: readonly SiteGrant[] = ["skill_reviewer"];

interface TeamBody {
  readonly team: TeamAccess["team"];
  readonly role: TeamRole;
  readonly permissions: readonly string[];
}

function siteRoleOf(role: MeBody["siteRole"]): SiteRole {
  return role === "owner" || role === "admin" ? role : "user";
}

export async function fetchSiteAccess(fetchFn?: typeof fetch): Promise<ApiResult<SiteAccess>> {
  const me = await apiRequest<MeBody>("/v1/me", { fetchFn });
  if (!me.ok) return me;
  const { id, name, email } = me.data.user;
  return {
    ...me,
    data: {
      console: "site",
      user: { id, name, email },
      siteRole: siteRoleOf(me.data.siteRole),
      grants: (me.data.siteGrants ?? []).filter((g): g is SiteGrant =>
        (SITE_GRANTS as readonly string[]).includes(g),
      ),
    },
  };
}

/** The active team and the caller's role and permissions in it (409 `no_active_team` if none). */
export async function fetchTeamAccess(fetchFn?: typeof fetch): Promise<ApiResult<TeamAccess>> {
  const [me, team] = await Promise.all([
    apiRequest<MeBody>("/v1/me", { fetchFn }),
    apiRequest<TeamBody>("/v1/team", { fetchFn }),
  ]);
  if (!me.ok) return me;
  if (!team.ok) return team;
  const { id, name, email } = me.data.user;
  return {
    ...team,
    data: {
      console: "team",
      user: { id, name, email },
      team: team.data.team,
      role: team.data.role,
      permissions: team.data.permissions,
      siteAdmin: siteRoleOf(me.data.siteRole) !== "user",
    },
  };
}
