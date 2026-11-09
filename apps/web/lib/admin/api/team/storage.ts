/**
 * Team console: storage and project history (Workspaces GV2, GV3, MT3; KOBE-579 routes):
 * `GET /v1/team/storage` (the view) and `PUT /v1/team/storage` (team admins; any of
 * `history_keep`, `max_mounted_per_member`, `max_objects`), which answers the view again.
 */
import { apiRequest, type ApiResult } from "../../../api/client";
import {
  storageSettingsBody,
  teamStorageFromWire,
  type StorageSettingsChange,
  type TeamStorage,
} from "../../../projects/storage";

const PATH = "/v1/team/storage";

const mapped = (res: ApiResult<unknown>): ApiResult<TeamStorage> =>
  res.ok ? { ...res, data: teamStorageFromWire(res.data) } : res;

export async function getTeamStorage(teamId: string): Promise<ApiResult<TeamStorage>> {
  return mapped(await apiRequest<unknown>(PATH, { teamId }));
}

export async function putTeamStorage(
  teamId: string,
  change: StorageSettingsChange,
): Promise<ApiResult<TeamStorage>> {
  return mapped(
    await apiRequest<unknown>(PATH, { method: "PUT", json: storageSettingsBody(change), teamId }),
  );
}
