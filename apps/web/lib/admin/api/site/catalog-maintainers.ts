/** Catalog skill maintainers (`/v1/skills/catalog/:id/maintainers`, KOBE-332, SK24). */
import { apiRequest, type ApiResult } from "../../../api/client";

export interface CatalogMaintainer {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly deactivated: boolean;
  readonly addedAt: string;
}

const path = (skillId: string) => `/v1/skills/catalog/${encodeURIComponent(skillId)}/maintainers`;
const list = (res: ApiResult<{ maintainers: CatalogMaintainer[] }>) =>
  res.ok ? { ...res, data: res.data.maintainers as readonly CatalogMaintainer[] } : res;

export async function listCatalogMaintainers(
  skillId: string,
): Promise<ApiResult<readonly CatalogMaintainer[]>> {
  return list(await apiRequest(path(skillId)));
}

export async function addCatalogMaintainer(
  skillId: string,
  userId: string,
): Promise<ApiResult<readonly CatalogMaintainer[]>> {
  return list(await apiRequest(path(skillId), { method: "POST", json: { userId } }));
}

export async function removeCatalogMaintainer(
  skillId: string,
  userId: string,
): Promise<ApiResult<readonly CatalogMaintainer[]>> {
  return list(
    await apiRequest(`${path(skillId)}/${encodeURIComponent(userId)}`, { method: "DELETE" }),
  );
}
