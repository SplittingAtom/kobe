import {
  DEFAULT_REMEMBER_LIMITS,
  REMEMBER_SCOPE_LABELS,
  type RememberLimits,
  type RememberScope,
  type ToolDescriptor,
} from "@kobe/protocol";
import { isLiteralGlob } from "./patterns.js";
import type { PolicyRule } from "./rules.js";

/**
 * Admin limits on remembered approvals, applied when a rule is evaluated (KOBE-289 ac-5), not only
 * when it is made: an admin who tightens the limits turns off the rules they no longer allow at
 * once. A remembered rule applies only while
 *
 * - the tool is not destructive (those are never remembered; a stored rule for one is ignored),
 * - its scope is one the limits still allow,
 * - it is younger than the max duration (counted from when it was made),
 * - it is not for an MCP tool when MCP tools may not be remembered, and
 * - it pins literal values when only exact actions may be remembered (an older rule whose pattern
 *   has a wildcard, such as `/workspace/*`, is not exact; review S4).
 */
export function rememberedRuleAllowed(
  rule: PolicyRule,
  tool: Pick<ToolDescriptor, "source" | "risk">,
  limits: RememberLimits = DEFAULT_REMEMBER_LIMITS,
  now: Date,
): boolean {
  return rememberedRuleRefusal(rule, tool, limits, now) === undefined;
}

/** Why a remembered rule no longer applies (the Approvals pages show it); undefined: it does. */
export type RuleRefusal =
  "destructive" | "scope_not_allowed" | "mcp_not_allowed" | "not_exact" | "too_old";

export const RULE_REFUSAL_TEXT: Readonly<Record<RuleRefusal, string>> = {
  destructive: "This tool can delete data, so approvals of it are never remembered.",
  scope_not_allowed: "Your team no longer allows remembering for this long.",
  mcp_not_allowed: "Your team no longer allows remembering connector tools.",
  not_exact: "Your team allows only exact actions to be remembered.",
  too_old: "It is older than your team's longest allowed duration.",
};

export function exactPattern(rule: PolicyRule): boolean {
  const pattern = rule.arg_pattern;
  return pattern !== undefined && Object.values(pattern).every((glob) => isLiteralGlob(glob));
}

export function rememberedRuleRefusal(
  rule: PolicyRule,
  tool: Pick<ToolDescriptor, "source" | "risk">,
  limits: RememberLimits = DEFAULT_REMEMBER_LIMITS,
  now: Date,
): RuleRefusal | undefined {
  if (tool.risk === "destructive") return "destructive";
  const scope = scopeOf(rule);
  if (!limits.scopes.includes(scope)) return "scope_not_allowed";
  if (tool.source === "mcp" && !limits.mcp_tools) return "mcp_not_allowed";
  if (limits.exact_only && !exactPattern(rule)) return "not_exact";
  const max = limits.max_duration_seconds;
  if (max === null) return undefined;
  const made = rule.created_at === undefined ? Number.NaN : Date.parse(rule.created_at);
  // No readable creation time under a max duration: the rule can't be shown to be young enough.
  if (Number.isNaN(made)) return "too_old";
  return made + max * 1000 > now.getTime() ? undefined : "too_old";
}

/** A user rule's scope; rules built without one (tests, older callers) are "until revoked". */
export function scopeOf(rule: PolicyRule): RememberScope {
  return rule.remember_scope ?? "forever";
}

/** "Allowed by your rule (this conversation)": the tool card's and the reason's words. */
export function allowedByRuleMessage(scope: RememberScope): string {
  return `Allowed by your rule (${REMEMBER_SCOPE_LABELS[scope]}).`;
}
