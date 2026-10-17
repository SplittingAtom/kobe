import {
  DEFAULT_REMEMBER_LIMITS,
  REMEMBER_SCOPE_LABELS,
  type RememberLimits,
  type RememberScope,
  type ToolDescriptor,
} from "@kobe/protocol";
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
 * - it has an argument pattern when only exact actions may be remembered.
 */
export function rememberedRuleAllowed(
  rule: PolicyRule,
  tool: Pick<ToolDescriptor, "source" | "risk">,
  limits: RememberLimits = DEFAULT_REMEMBER_LIMITS,
  now: Date,
): boolean {
  if (tool.risk === "destructive") return false;
  const scope = scopeOf(rule);
  if (!limits.scopes.includes(scope)) return false;
  if (tool.source === "mcp" && !limits.mcp_tools) return false;
  if (limits.exact_only && rule.arg_pattern === undefined) return false;
  const max = limits.max_duration_seconds;
  if (max === null) return true;
  const made = rule.created_at === undefined ? Number.NaN : Date.parse(rule.created_at);
  // No readable creation time under a max duration: the rule can't be shown to be young enough.
  if (Number.isNaN(made)) return false;
  return made + max * 1000 > now.getTime();
}

/** A user rule's scope; rules built without one (tests, older callers) are "until revoked". */
export function scopeOf(rule: PolicyRule): RememberScope {
  return rule.remember_scope ?? "forever";
}

/** "Allowed by your rule (this conversation)": the tool card's and the reason's words. */
export function allowedByRuleMessage(scope: RememberScope): string {
  return `Allowed by your rule (${REMEMBER_SCOPE_LABELS[scope]}).`;
}
