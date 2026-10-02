/** Install console: policy floor (`/v1/install/policy`, install.policy.manage; KOBE-35). */
import { apiRequest, type ApiResult } from "../../../api/client";
import { ruleBody, type NewRule, type PolicyRule } from "../policy";

const enc = encodeURIComponent;
const BASE = "/v1/install/policy";

export async function listInstallRules(): Promise<ApiResult<readonly PolicyRule[]>> {
  const res = await apiRequest<{ rules: PolicyRule[] }>(`${BASE}/rules`);
  return res.ok ? { ...res, data: res.data.rules } : res;
}

/** The floor only restricts: deny or ask (the server refuses allow). */
export async function createInstallRule(
  rule: NewRule & { readonly effect: "deny" | "ask" },
): Promise<ApiResult<PolicyRule>> {
  const res = await apiRequest<{ rule: PolicyRule }>(`${BASE}/rules`, {
    method: "POST",
    json: ruleBody(rule),
  });
  return res.ok ? { ...res, data: res.data.rule } : res;
}

export function deleteInstallRule(id: string): Promise<ApiResult<void>> {
  return apiRequest(`${BASE}/rules/${enc(id)}`, { method: "DELETE" });
}

export interface PolicySettings {
  readonly promptSandboxWrites: boolean;
}

export function getPolicySettings(): Promise<ApiResult<PolicySettings>> {
  return apiRequest(`${BASE}/settings`);
}

export function putPolicySettings(settings: PolicySettings): Promise<ApiResult<PolicySettings>> {
  return apiRequest(`${BASE}/settings`, {
    method: "PUT",
    json: { promptSandboxWrites: settings.promptSandboxWrites },
  });
}
