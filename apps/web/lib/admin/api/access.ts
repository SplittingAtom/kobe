/** Who the caller is to each console, as the server says (never cached client state). */
import { apiRequest, type ApiResult } from "../../api/client";
import type { TeamRole } from "../../teams";
import type { CurrentUser, InstallAccess, InstallRole, TeamAccess } from "../nav/types";

interface MeBody {
  readonly user: CurrentUser;
  readonly installRole: "owner" | "admin" | null;
}

interface TeamBody {
  readonly team: TeamAccess["team"];
  readonly role: TeamRole;
  readonly permissions: readonly string[];
}

function installRoleOf(role: MeBody["installRole"]): InstallRole {
  return role === "owner" || role === "admin" ? role : "user";
}

export async function fetchInstallAccess(
  fetchFn?: typeof fetch,
): Promise<ApiResult<InstallAccess>> {
  const me = await apiRequest<MeBody>("/v1/me", { fetchFn });
  if (!me.ok) return me;
  const { id, name, email } = me.data.user;
  return {
    ...me,
    data: {
      console: "install",
      user: { id, name, email },
      installRole: installRoleOf(me.data.installRole),
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
    },
  };
}
