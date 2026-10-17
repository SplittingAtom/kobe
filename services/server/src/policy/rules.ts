import type {
  ArgPattern,
  JsonObject,
  RememberLimits,
  RememberScope,
  ToolDescriptor,
} from "@kobe/protocol";
import {
  allowGlobScoped,
  isLiteralGlob,
  matchArgPattern,
  matchSubject,
  type MatchBias,
} from "./patterns.js";

/** Where a rule comes from. */
export type RuleScope = "site" | "team" | "user";
export type RuleEffect = "deny" | "ask" | "allow";

/** A tool rule as the engine evaluates it (rows from `site_tool_rules` and `tool_rules`). */
export interface PolicyRule {
  /** `site_tool_rules.id` / `tool_rules.id`. */
  readonly id: string;
  readonly scope: RuleScope;
  readonly effect: RuleEffect;
  readonly tool_glob: string;
  readonly arg_pattern?: ArgPattern;
  /** ISO timestamp; a rule at or past it is ignored. */
  readonly expires_at?: string;
  /** User rules (KOBE-289): the scope the member chose. Absent (older callers) = until revoked. */
  readonly remember_scope?: RememberScope;
  /** `thread` rules: the only thread whose calls it allows. */
  readonly thread_id?: string;
  /** `run` rules: the only run whose calls it allows. */
  readonly run_id?: string;
  /** ISO timestamp the rule was made (admins' max duration counts from it). */
  readonly created_at?: string;
  /**
   * "Only this exact action" over every top-level argument (KOBE-289 review S3): the input's
   * top-level keys must be exactly the pattern's, so an extra or a missing argument never matches.
   */
  readonly exact_keys?: boolean;
}

/** The run a call belongs to: thread- and run-bound rules match only their own. */
export interface CallBinding {
  readonly thread_id: string;
  readonly run_id: string;
}

/** The rules that apply to one decision: site floor, the active team's, and the caller's own. */
export interface PolicyRuleSet {
  readonly site: readonly PolicyRule[];
  readonly team: readonly PolicyRule[];
  /** The acting user's remember-rules in the active team. */
  readonly user: readonly PolicyRule[];
  /**
   * The team's effective remember limits (site floor tightened by the team, KOBE-289); absent =
   * none set. Remembered rules a limit no longer allows stop applying at once.
   */
  readonly remember_limits?: RememberLimits;
}

export const EMPTY_RULE_SET: PolicyRuleSet = { site: [], team: [], user: [] };

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

/**
 * Whether a bound rule is bound to this call (KOBE-289): a `thread` rule only in its thread, a
 * `run` rule only in its run. A bound rule without a call to compare against, or a `thread`/`run`
 * rule that names none, never matches (fail closed).
 */
export function bindingMatches(rule: PolicyRule, binding: CallBinding | undefined): boolean {
  if (rule.remember_scope === "thread" && rule.thread_id === undefined) return false;
  if (rule.remember_scope === "run" && rule.run_id === undefined) return false;
  if (rule.thread_id !== undefined && rule.thread_id !== binding?.thread_id) return false;
  if (rule.run_id !== undefined && rule.run_id !== binding?.run_id) return false;
  return true;
}

/** RFC 6901 unescaping of one reference token. */
function unescapeToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * An exact rule's key check (S3): every pattern pointer names one top-level key, and the input has
 * exactly those keys. A pattern with a deeper pointer can't be checked this way: no match.
 */
export function exactKeysMatch(pattern: ArgPattern | undefined, input: JsonObject): boolean {
  if (pattern === undefined) return false;
  const pinned = new Set<string>();
  for (const pointer of Object.keys(pattern)) {
    const tokens = pointer.split("/").slice(1);
    if (tokens.length !== 1) return false;
    pinned.add(unescapeToken(tokens[0] ?? ""));
  }
  const keys = Object.keys(input);
  return keys.length === pinned.size && keys.every((k) => pinned.has(k));
}

/** Whether `rule` applies to this call: active, tool glob matches the name, arg pattern matches. */
export function ruleMatches(
  rule: PolicyRule,
  tool: ToolDescriptor,
  input: JsonObject,
  now: Date,
  binding?: CallBinding,
): boolean {
  if (!isRuleActive(rule, now)) return false;
  if (!bindingMatches(rule, binding)) return false;
  // Allow rules must name one built-in or one connector; a user's remember-rule exactly one tool
  // (stored rows are checked on write too).
  if (rule.effect === "allow" && !allowGlobScoped(rule.tool_glob)) return false;
  if (rule.effect === "allow" && rule.scope === "user" && !isLiteralGlob(rule.tool_glob)) {
    return false;
  }
  const bias = biasOf(rule.effect);
  if (!matchSubject(rule.tool_glob, tool.name, bias)) return false;
  if (rule.exact_keys === true && !exactKeysMatch(rule.arg_pattern, input)) return false;
  return rule.arg_pattern === undefined || matchArgPattern(rule.arg_pattern, input, bias);
}

/** Matching rules of one effect, by id, so the same rules and call report the same `rule_id`. */
export function matchingRules(
  rules: readonly PolicyRule[],
  effect: RuleEffect,
  tool: ToolDescriptor,
  input: JsonObject,
  now: Date,
  binding?: CallBinding,
): PolicyRule[] {
  // Code-unit order (locale-independent).
  return rules
    .filter((r) => r.effect === effect && ruleMatches(r, tool, input, now, binding))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
