/** Install console: isolation (`/v1/install`, install.settings.manage). Responses arrive camelized. */
import { apiRequest, type ApiResult } from "../../../api/client";

export type IsolationStatus =
  | {
      readonly state: "checking";
      readonly agentsEnabled: false;
      readonly runtimeClassName?: string;
    }
  | {
      readonly state: "verified";
      readonly agentsEnabled: true;
      readonly runtimeClassName: string;
      readonly handler: string;
      readonly checkedAt: string;
    }
  | {
      readonly state: "missing";
      readonly agentsEnabled: false;
      readonly runtimeClassName?: string;
      readonly message: string;
      readonly checkedAt: string;
      readonly docs: string;
    };

export function getIsolation(): Promise<ApiResult<IsolationStatus>> {
  return apiRequest("/v1/install/isolation");
}

export function recheckIsolation(): Promise<ApiResult<IsolationStatus>> {
  return apiRequest("/v1/install/isolation/check", { method: "POST" });
}
