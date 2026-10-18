import { toolRules, type AuditActor, type KobeTx } from "@kobe/db";
import {
  BUILTIN_TOOLS,
  parseMcpToolName,
  rememberRuleSchema,
  scopeWithinLimits,
  type JsonObject,
  type RememberLimits,
  type ToolDescriptor,
} from "@kobe/protocol";
import { threadLiveFor } from "./live-rule.js";
import { allowGlobScoped, isLiteralGlob } from "./patterns.js";
import { exactArgPattern, exactPinsAllArguments, rememberExpiry } from "./remember-scope.js";
import { auditRule, fitsScope, storedTeam, type StoredRule } from "./rule-store.js";
import { USER_LIMITS } from "./schemas.js";
import { pruneEndedUserRules } from "./user-rules.js";

export type RememberError =
  | "invalid_rule"
  | "glob_too_broad"
  | "too_many_rules"
  | "remember_not_allowed"
  | "exact_unavailable"
  | "thread_not_live";
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

/** The approval a remember-rule is made from: all of it read from the server's own rows. */
export interface ApprovedCall {
  readonly tool: ToolDescriptor;
  /** The approval's stored canonical input, parsed: the exact action "only this" pins. */
  readonly input: JsonObject;
  readonly threadId: string;
  readonly runId: string;
}

/**
 * Why a remember choice may not be made for this call under `limits` (undefined: it may). The
 * card is told the same through the approval's remember options; the server refuses anyway.
 */
export function rememberRefusal(
  scope: Parameters<typeof scopeWithinLimits>[0],
  exact: boolean,
  call: Pick<ApprovedCall, "tool">,
  limits: RememberLimits,
): "remember_not_allowed" | undefined {
  if (call.tool.risk === "destructive") return "remember_not_allowed";
  if (!scopeWithinLimits(scope, limits)) return "remember_not_allowed";
  if (call.tool.source === "mcp" && !limits.mcp_tools) return "remember_not_allowed";
  if (limits.exact_only && !exact) return "remember_not_allowed";
  return undefined;
}

/**
 * "Approve and remember" (D29, §6.1 `remember`; scopes KOBE-289): stores a user allow rule in the
 * active team. KOBE-37 calls this inside its `withTeam` transaction that resolves the approval,
 * after verifying the approval belongs to `userId`, and passes the approval's own call (tool,
 * stored input, thread, run). Everything the rule holds is decided here, server-side:
 *
 * - the tool glob must be exactly the approved tool (`glob_too_broad`);
 * - the scope must be allowed by the team's effective limits, the tool not destructive, not an MCP
 *   tool when those may not be remembered, and exact when only exact actions may be
 *   (`remember_not_allowed`);
 * - "only this exact action" derives the pattern from the stored canonical input
 *   (`exactArgPattern`; `exact_unavailable` when none fits);
 * - the expiry comes from the clock, the member's stored time zone and the max duration;
 * - `thread` and `run` rules name the approval's own thread and run.
 *
 * The rule only removes future prompts from risk class or mode in interactive runs; deny and ask
 * rules still win, and unattended runs never use it (evaluate.ts).
 */
export async function insertUserAllowRule(
  tx: KobeTx,
  params: {
    readonly teamId: string;
    readonly userId: string;
    readonly call: ApprovedCall;
    readonly remember: unknown;
    readonly limits: RememberLimits;
    /** The member's stored IANA time zone (null: UTC). */
    readonly timeZone: string | null;
    readonly now: Date;
    /**
     * Who approved and remembered (audit, KOBE-15): required, so the rule is never created
     * unaudited. Usually `{ kind: "user", id: userId }`.
     */
    readonly actor: AuditActor;
  },
): Promise<RememberResult> {
  const parsed = rememberRuleSchema.safeParse(params.remember);
  if (!parsed.success) return { ok: false, error: "invalid_rule" };
  const rule = parsed.data;
  const { call } = params;
  if (!rememberGlobAllowed(rule.tool_glob, call.tool.name)) {
    return { ok: false, error: "glob_too_broad" };
  }
  const refusal = rememberRefusal(rule.scope, rule.exact, call, params.limits);
  if (refusal) return { ok: false, error: refusal };
  const argPattern = rule.exact ? exactArgPattern(call.tool, call.input) : undefined;
  if (rule.exact && argPattern === undefined) return { ok: false, error: "exact_unavailable" };

  // A thread already archived, trashed or out of reach can't get a rule: unarchiving would
  // otherwise bring it back (review R1).
  if (
    rule.scope === "thread" &&
    !(await threadLiveFor(tx, params.teamId, call.threadId, params.userId))
  ) {
    return { ok: false, error: "thread_not_live" };
  }
  await pruneEndedUserRules(tx, params.teamId, params.userId, params.now);
  const scope = { table: "user", teamId: params.teamId, userId: params.userId } as const;
  if (!(await fitsScope(tx, scope, argPattern ?? null, USER_LIMITS))) {
    return { ok: false, error: "too_many_rules" };
  }
  const expiresAt = rememberExpiry(
    rule.scope,
    params.now,
    params.timeZone,
    params.limits.max_duration_seconds,
  );
  const [row] = await tx
    .insert(toolRules)
    .values({
      teamId: params.teamId,
      scope: "user",
      userId: params.userId,
      effect: "allow",
      toolGlob: rule.tool_glob,
      argPattern: argPattern ?? null,
      createdBy: params.userId,
      createdAt: params.now,
      expiresAt,
      rememberScope: rule.scope,
      threadId: rule.scope === "thread" ? call.threadId : null,
      runId: rule.scope === "run" ? call.runId : null,
      exactKeys: argPattern !== undefined && exactPinsAllArguments(call.tool),
    })
    .returning();
  if (!row) throw new Error("user rule insert returned no row");
  const stored = storedTeam(row);
  await auditRule(tx, "policy.rule.created", stored, params.teamId, params.actor);
  return { ok: true, rule: stored };
}
