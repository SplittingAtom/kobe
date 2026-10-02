import { z } from "zod";
import { argPatternSchema, globSchema, timestampSchema } from "@kobe/protocol";
import { allowGlobScoped } from "./patterns.js";

/**
 * Caps per scope (install; team; one user in one team): rules and `arg_pattern` entries across
 * them. Bounds evaluation work per decision (≤ 3 scopes × these).
 */
export const SCOPE_LIMITS = { rules: 500, argEntries: 2000 } as const;
export const USER_LIMITS = { rules: 200, argEntries: 800 } as const;

const noteSchema = z.string().trim().max(500);

/** A future ISO timestamp, or null for "until revoked". */
const expiresAtSchema = timestampSchema.nullable();

const ruleFields = {
  tool_glob: globSchema,
  arg_pattern: argPatternSchema.nullable().default(null),
  note: noteSchema.nullable().default(null),
  expires_at: expiresAtSchema.default(null),
};

/** Install floor (D6): deny and ask only — the floor never loosens. */
export const installRuleBodySchema = z.strictObject({
  effect: z.enum(["deny", "ask"]),
  ...ruleFields,
});
export type InstallRuleBody = z.infer<typeof installRuleBodySchema>;

/**
 * Team rules (D6): deny, ask, or allow. Team allow rules pre-approve a tool for the team's members
 * like a remember-rule (they remove only risk-class/mode prompts and never override deny or ask
 * rules from the install or the team).
 */
export const teamRuleBodySchema = z
  .strictObject({
    effect: z.enum(["deny", "ask", "allow"]),
    ...ruleFields,
  })
  .refine((rule) => rule.effect !== "allow" || allowGlobScoped(rule.tool_glob), {
    path: ["tool_glob"],
    message:
      "an allow rule must name one built-in tool or one connector's tools (mcp__<server>__…)",
  });
export type TeamRuleBody = z.infer<typeof teamRuleBodySchema>;

export const ruleIdSchema = z.uuid();

/** Install policy switches (settings.ts). */
export const policySettingsBodySchema = z.strictObject({
  promptSandboxWrites: z.boolean(),
});

/** Expiry must be in the future when set (an already-expired rule would be a silent no-op). */
export function expiresInFuture(expiresAt: string | null, now: Date): boolean {
  return expiresAt === null || Date.parse(expiresAt) > now.getTime();
}

/** The fields every rule body shares (after defaults). */
export interface RuleBodyFields {
  readonly expires_at: string | null;
}
