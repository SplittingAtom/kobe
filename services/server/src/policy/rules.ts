import type { ArgPattern, JsonObject, ToolDescriptor } from "@kobe/protocol";
import {
  allowGlobScoped,
  isLiteralGlob,
  matchArgPattern,
  matchSubject,
  type MatchBias,
} from "./patterns.js";

/** Where a rule comes from. */
export type RuleScope = "install" | "team" | "user";
export type RuleEffect = "deny" | "ask" | "allow";

/** A tool rule as the engine evaluates it (rows from `install_tool_rules` and `tool_rules`). */
export interface PolicyRule {
  /** `install_tool_rules.id` / `tool_rules.id`. */
  readonly id: string;
  readonly scope: RuleScope;
  readonly effect: RuleEffect;
  readonly tool_glob: string;
  readonly arg_pattern?: ArgPattern;
  /** ISO timestamp; a rule at or past it is ignored. */
  readonly expires_at?: string;
}

/** The rules that apply to one decision: install floor, the active team's, and the caller's own. */
export interface PolicyRuleSet {
  readonly install: readonly PolicyRule[];
  readonly team: readonly PolicyRule[];
  /** The acting user's remember-rules in the active team. */
  readonly user: readonly PolicyRule[];
}

export const EMPTY_RULE_SET: PolicyRuleSet = { install: [], team: [], user: [] };

function biasOf(effect: RuleEffect): MatchBias {
  return effect === "allow" ? "loosen" : "restrict";
}

export function isRuleActive(rule: PolicyRule, now: Date): boolean {
  if (rule.expires_at === undefined) return true;
  const expires = Date.parse(rule.expires_at);
  // An unreadable expiry is treated as expired for allow rules and as live for deny/ask.
  if (Number.isNaN(expires)) return rule.effect !== "allow";
  return expires > now.getTime();
}

/** Whether `rule` applies to this call: active, tool glob matches the name, arg pattern matches. */
export function ruleMatches(
  rule: PolicyRule,
  tool: ToolDescriptor,
  input: JsonObject,
  now: Date,
): boolean {
  if (!isRuleActive(rule, now)) return false;
  // Allow rules must name one built-in or one connector; a user's remember-rule exactly one tool
  // (stored rows are checked on write too).
  if (rule.effect === "allow" && !allowGlobScoped(rule.tool_glob)) return false;
  if (rule.effect === "allow" && rule.scope === "user" && !isLiteralGlob(rule.tool_glob)) {
    return false;
  }
  const bias = biasOf(rule.effect);
  if (!matchSubject(rule.tool_glob, tool.name, bias)) return false;
  return rule.arg_pattern === undefined || matchArgPattern(rule.arg_pattern, input, bias);
}

/** Matching rules of one effect, by id, so the same rules and call report the same `rule_id`. */
export function matchingRules(
  rules: readonly PolicyRule[],
  effect: RuleEffect,
  tool: ToolDescriptor,
  input: JsonObject,
  now: Date,
): PolicyRule[] {
  // Code-unit order (locale-independent).
  return rules
    .filter((r) => r.effect === effect && ruleMatches(r, tool, input, now))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
