import { toolRules, type KobeTx } from "@kobe/db";
import { BUILTIN_TOOLS, parseMcpToolName, rememberRuleSchema } from "@kobe/protocol";
import { allowGlobScoped, isLiteralGlob } from "./patterns.js";
import { fitsScope, storedTeam, type StoredRule } from "./rule-store.js";
import { USER_LIMITS } from "./schemas.js";

export type RememberError = "invalid_rule" | "glob_too_broad" | "too_many_rules";
export type RememberResult = { ok: true; rule: StoredRule } | { ok: false; error: RememberError };

/**
 * Whether a remember-rule's tool glob is exactly the approved tool (D29: "user × tool glob";
 * review KOBE-35 MEDIUM 6): the stored rule names that one tool — never `mcp__github__*` — and may
 * narrow further with `arg_pattern`.
 */
export function rememberGlobAllowed(toolGlob: string, approvedTool: string): boolean {
  return (
    toolGlob === approvedTool &&
    isLiteralGlob(toolGlob) &&
    allowGlobScoped(toolGlob) &&
    (Object.hasOwn(BUILTIN_TOOLS, approvedTool) || parseMcpToolName(approvedTool) !== undefined)
  );
}

/**
 * "Approve and remember" (D29, §6.1 `remember`): stores a user allow rule in the active team.
 * KOBE-37 calls this inside its `withTeam` transaction that resolves the approval, after verifying
 * the approval belongs to `userId` and named `approvedTool`. The rule only removes future prompts
 * from risk class or mode; deny and ask rules still win (evaluate.ts).
 */
export async function insertUserAllowRule(
  tx: KobeTx,
  params: {
    readonly teamId: string;
    readonly userId: string;
    readonly approvedTool: string;
    readonly remember: unknown;
    readonly now: Date;
  },
): Promise<RememberResult> {
  const parsed = rememberRuleSchema.safeParse(params.remember);
  if (!parsed.success) return { ok: false, error: "invalid_rule" };
  const rule = parsed.data;
  if (!rememberGlobAllowed(rule.tool_glob, params.approvedTool)) {
    return { ok: false, error: "glob_too_broad" };
  }
  const scope = { table: "user", teamId: params.teamId, userId: params.userId } as const;
  if (!(await fitsScope(tx, scope, rule.arg_pattern ?? null, USER_LIMITS))) {
    return { ok: false, error: "too_many_rules" };
  }
  const expiresAt =
    rule.expires_in === undefined ? null : new Date(params.now.getTime() + rule.expires_in * 1000);
  const [row] = await tx
    .insert(toolRules)
    .values({
      teamId: params.teamId,
      scope: "user",
      userId: params.userId,
      effect: "allow",
      toolGlob: rule.tool_glob,
      argPattern: rule.arg_pattern ?? null,
      createdBy: params.userId,
      expiresAt,
    })
    .returning();
  if (!row) throw new Error("user rule insert returned no row");
  return { ok: true, rule: storedTeam(row) };
}
