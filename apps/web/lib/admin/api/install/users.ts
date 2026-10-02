/** Install console: users (`/v1/install`, install.users.manage). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { InstallRole } from "../../nav/types";

const enc = encodeURIComponent;

export interface InstallUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly installRole: InstallRole;
  readonly twoFactorEnabled: boolean;
  readonly deactivatedAt: string | null;
  readonly createdAt: string;
}

export interface DeactivationResult {
  readonly userId: string;
  readonly deactivated: boolean;
  /** Teams whose only active team admin this was (deactivation only). */
  readonly teamsWithoutActiveAdmin?: readonly {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  }[];
  /** Downstream steps (sandboxes, grants, schedules…) that failed; deactivation still holds. */
  readonly incompleteSteps: readonly string[];
}

export async function listUsers(): Promise<ApiResult<readonly InstallUser[]>> {
  const res = await apiRequest<{ users: InstallUser[] }>("/v1/install/users");
  return res.ok ? { ...res, data: res.data.users } : res;
}

export function setUserActive(
  userId: string,
  active: boolean,
): Promise<ApiResult<DeactivationResult>> {
  return apiRequest(`/v1/install/users/${enc(userId)}/${active ? "reactivate" : "deactivate"}`, {
    method: "POST",
  });
}
