/** Team console: team tool policy (`/v1/team/policy`, team.policy.manage; KOBE-35). */
import { apiRequest, type ApiResult } from "../../../api/client";
import { ruleBody, type NewRule, type PolicyRule } from "../policy";

const enc = encodeURIComponent;

export async function listTeamRules(teamId: string): Promise<ApiResult<readonly PolicyRule[]>> {
  const res = await apiRequest<{ rules: PolicyRule[] }>("/v1/team/policy/rules", { teamId });
  return res.ok ? { ...res, data: res.data.rules } : res;
}

export async function createTeamRule(
  teamId: string,
  rule: NewRule,
): Promise<ApiResult<PolicyRule>> {
  const res = await apiRequest<{ rule: PolicyRule }>("/v1/team/policy/rules", {
    method: "POST",
    json: ruleBody(rule),
    teamId,
  });
  return res.ok ? { ...res, data: res.data.rule } : res;
}

export function deleteTeamRule(teamId: string, id: string): Promise<ApiResult<void>> {
  return apiRequest(`/v1/team/policy/rules/${enc(id)}`, { method: "DELETE", teamId });
}
