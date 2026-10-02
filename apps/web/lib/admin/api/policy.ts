/** Tool policy rules as `/v1/install/policy` and `/v1/team/policy` return them (KOBE-35). */

export type RuleEffect = "deny" | "ask" | "allow";

/** A stored rule (the server sends snake_case; it arrives camelized, `argPattern` kept verbatim). */
export interface PolicyRule {
  readonly id: string;
  readonly scope: "install" | "team" | "user";
  readonly effect: RuleEffect;
  readonly toolGlob: string;
  /** JSON pointer → glob over the tool input; keys are pointers, never camelized. */
  readonly argPattern: Readonly<Record<string, string>> | null;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface NewRule {
  readonly effect: RuleEffect;
  readonly toolGlob: string;
  readonly note: string | null;
  readonly expiresAt: string | null;
}

/** The rule body in the routes' wire casing (snake_case, strict schema). */
export function ruleBody(rule: NewRule) {
  return {
    effect: rule.effect,
    tool_glob: rule.toolGlob,
    note: rule.note,
    expires_at: rule.expiresAt,
  };
}
