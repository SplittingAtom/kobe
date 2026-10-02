import type { ArgPattern, JsonObject, ToolDescriptor } from "@kobe/protocol";
import { allowGlobScoped, matchArgPattern, matchSubject, type MatchBias } from "./patterns.js";

/** Where a rule comes from. `builtin` rules are fixed in code (allow-rules below). */
export type RuleScope = "install" | "team" | "user" | "builtin";
export type RuleEffect = "deny" | "ask" | "allow";

/** A tool rule as the engine evaluates it (rows from `install_tool_rules` and `tool_rules`). */
export interface PolicyRule {
  /** `install_tool_rules.id` / `tool_rules.id`; absent for built-in rules. */
  readonly id?: string;
  readonly scope: RuleScope;
  readonly effect: RuleEffect;
  readonly tool_glob: string;
  readonly arg_pattern?: ArgPattern;
  /** ISO timestamp; a rule at or past it is ignored. */
  readonly expires_at?: string;
  /** Shown as the reason message for built-in rules. */
  readonly message?: string;
}

/** The rules that apply to one decision: install floor, the active team's, and the caller's own. */
export interface PolicyRuleSet {
  readonly install: readonly PolicyRule[];
  readonly team: readonly PolicyRule[];
  /** The acting user's remember-rules in the active team. */
  readonly user: readonly PolicyRule[];
}

export const EMPTY_RULE_SET: PolicyRuleSet = { install: [], team: [], user: [] };

/**
 * Built-in allow rules, evaluated with user allow rules (they can't override deny or ask rules).
 * D24: personal `remember` writes need no approval. The pattern requires `scope: "personal"` in the
 * input, so a project-memory write (or a `remember` input shape KOBE-55/56 defines differently)
 * still prompts — fail closed until the tool's schema is settled.
 */
export const BUILTIN_ALLOW_RULES: readonly PolicyRule[] = [
  {
    scope: "builtin",
    effect: "allow",
    tool_glob: "remember",
    arg_pattern: { "/scope": "personal" },
    message: "Personal memory writes need no approval (they can be undone).",
  },
];

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
  // Allow rules must name one built-in or one connector (stored rows are checked on write too).
  if (rule.effect === "allow" && !allowGlobScoped(rule.tool_glob)) return false;
  const bias = biasOf(rule.effect);
  if (!matchSubject(rule.tool_glob, tool.name, bias)) return false;
  return rule.arg_pattern === undefined || matchArgPattern(rule.arg_pattern, input, bias);
}

/**
 * Matching rules of one effect, in a deterministic order (by id; built-ins last),
 * so the same rules and call always report the same `rule_id`.
 */
export function matchingRules(
  rules: readonly PolicyRule[],
  effect: RuleEffect,
  tool: ToolDescriptor,
  input: JsonObject,
  now: Date,
): PolicyRule[] {
  // Code-unit order (locale-independent); built-ins (no id) after stored rules, stable among themselves.
  const key = (r: PolicyRule): string => r.id ?? "~";
  return rules
    .filter((r) => r.effect === effect && ruleMatches(r, tool, input, now))
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
