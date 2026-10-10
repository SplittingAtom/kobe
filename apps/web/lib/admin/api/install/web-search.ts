/** Install console: web search provider (`/v1/install/web-search`, KOBE-113). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";

export type WebSearchProviderId = "brave" | "tavily" | "exa";

export interface WebSearchProviderOption {
  readonly id: WebSearchProviderId;
  readonly label: string;
  readonly domain: string;
}

export interface InstallWebSearch {
  readonly configured: boolean;
  readonly provider: WebSearchProviderId | null;
  readonly enabled: boolean;
  /** Masked (last four characters). The key itself is never returned. */
  readonly hint: string | null;
  readonly updatedAt: string | null;
  readonly providers: readonly WebSearchProviderOption[];
}

export function getInstallWebSearch(): Promise<ApiResult<InstallWebSearch>> {
  return apiRequest("/v1/install/web-search");
}

/** `apiKey` is required for a first provider or a change of provider; omit it to keep the key. */
export function putInstallWebSearch(change: {
  readonly provider: WebSearchProviderId;
  readonly apiKey?: string | undefined;
  readonly enabled?: boolean | undefined;
}): Promise<ApiResult<InstallWebSearch>> {
  return apiRequest("/v1/install/web-search", {
    method: "PUT",
    json: {
      provider: change.provider,
      ...(change.apiKey ? { api_key: change.apiKey } : {}),
      ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
    },
  });
}

export function deleteInstallWebSearch(): Promise<ApiResult<null>> {
  return apiRequest("/v1/install/web-search", { method: "DELETE" });
}
