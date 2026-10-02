import { toolRules, type KobeTx } from "@kobe/db";
import { BUILTIN_TOOLS, parseMcpToolName, rememberRuleSchema } from "@kobe/protocol";
import { allowGlobScoped, literalPrefix, matchSubject } from "./patterns.js";
import { countScoped, lockScope, storedTeam, type StoredRule } from "./rule-store.js";
import { MAX_USER_RULES } from "./schemas.js";

export type RememberError = "invalid_rule" | "glob_too_broad" | "too_many_rules";
export type RememberResult = { ok: true; rule: StoredRule } | { ok: false; error: RememberError };

/**
 * Whether a remember-rule's tool glob stays with the tool that was approved (D29: "user × tool
 * glob"). It must match that tool, and:
 * - for a built-in, be exactly its name (narrow further with `arg_pattern`);
 * - for an MCP tool, keep the literal `mcp__<server>__` prefix, so one approval can cover sibling
 *   tools of the same connector but never another connector or a built-in.
 */
export function rememberGlobAllowed(toolGlob: string, approvedTool: string): boolean {
  if (!matchSubject(toolGlob, approvedTool, "loosen") || !allowGlobScoped(toolGlob)) return false;
  if (Object.hasOwn(BUILTIN_TOOLS, approvedTool)) return toolGlob === approvedTool;
  const mcp = parseMcpToolName(approvedTool);
  if (mcp === undefined) return false;
  return literalPrefix(toolGlob).startsWith(`mcp__${mcp.server_segment}__`);
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
  await lockScope(tx, `kobe.tool_rules.user.${params.teamId}.${params.userId}`);
  if ((await countScoped(tx, "user", params.userId)) >= MAX_USER_RULES) {
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
