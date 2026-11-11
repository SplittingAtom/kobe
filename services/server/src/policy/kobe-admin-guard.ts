import {
  APPROVAL_TTL_MS,
  parseMcpToolName,
  type PolicyDecision,
  type PolicyInput,
  type PolicyReason,
  type ToolDescriptor,
} from "@kobe/protocol";
import { KOBE_BUILTIN_CONNECTOR_ID } from "@kobe/db";

/**
 * The Kobe admin guard (KOBE-619, spec kobe-admin-mcp §6, KA2), applied after the policy engine at
 * both enforcement points (the sandbox's `policy.check` and the MCP proxy's re-check), like the
 * viewed-file guard:
 *
 * - a Kobe admin **write** asks in every approval mode, Dangerous and remembered approvals
 *   included (their allow reasons are dropped, so neither is recorded as having applied);
 * - where nobody can be asked it is denied: `auto` here, scheduled runs and skill evals below;
 * - a Kobe admin tool of any kind is denied in scheduled runs and skill evals (they get the docs
 *   tools only, §3);
 * - an engine deny stands as it is; reads otherwise follow the ordinary policy.
 *
 * Such an approval is never remembered (`approvals/remember-options.ts`, `approvals/decide.ts`)
 * nor approved in bulk (`approvals/approve-all.ts`). Reason codes `kobe_admin_write` and
 * `kobe_admin_not_allowed`.
 */
export const KOBE_ADMIN_WRITE_REASON = "kobe_admin_write";
export const KOBE_ADMIN_NOT_ALLOWED_REASON = "kobe_admin_not_allowed";

/** Why a Kobe admin approval offers no "remember" (and refuses one). */
export const KOBE_ADMIN_NOT_REMEMBERED =
  "Kobe admin changes are asked every time, so this approval is never remembered.";

/** A tool of the built-in Kobe connector, by the server's own descriptor. */
export function isKobeTool(tool: Pick<ToolDescriptor, "source" | "connector_id">): boolean {
  return tool.source === "mcp" && tool.connector_id === KOBE_BUILTIN_CONNECTOR_ID;
}

/** The Kobe tool's catalog name (`team_members_set_role`) from its Pi name. */
export function kobeToolName(piName: string): string | undefined {
  return parseMcpToolName(piName)?.tool_segment;
}

/** The approval was asked by this guard. */
export function isKobeAdminAsk(reasons: readonly { readonly code: string }[]): boolean {
  return reasons.some((r) => r.code === KOBE_ADMIN_WRITE_REASON);
}

const ALLOW_CODES: ReadonlySet<string> = new Set([
  "user_allow_rule",
  "team_allow_rule",
  "dangerous_mode",
]);

export interface KobeAdminGuard {
  readonly tool: ToolDescriptor;
  readonly input: PolicyInput;
  /** The run is a skill eval's (KOBE-325). */
  readonly evalRun: boolean;
  readonly now: Date;
}

function notAllowed(decision: PolicyDecision, message: string): PolicyDecision {
  return {
    effect: "deny",
    risk: decision.risk,
    reasons: [{ code: KOBE_ADMIN_NOT_ALLOWED_REASON, stage: "team_deny", message }],
  };
}

/** The decision with the guard applied: `decision` itself for every other tool. */
export function guardKobeAdmin(decision: PolicyDecision, g: KobeAdminGuard): PolicyDecision {
  if (!isKobeTool(g.tool) || decision.effect === "deny") return decision;
  if (g.input.actor.kind === "schedule" || g.evalRun) {
    return notAllowed(
      decision,
      "Kobe admin tools are not available in scheduled runs or skill evals; this call was denied.",
    );
  }
  if (g.tool.risk === "read") return decision;
  if (g.input.run.approval_mode === "auto") {
    return {
      effect: "deny",
      risk: decision.risk,
      reasons: [
        {
          code: KOBE_ADMIN_WRITE_REASON,
          stage: "approval_mode",
          message:
            "Kobe admin changes always need the person's approval, and this run never asks; it was denied.",
        },
      ],
    };
  }
  const ask: PolicyReason = {
    code: KOBE_ADMIN_WRITE_REASON,
    stage: "ask_rule",
    message: "A Kobe admin change: the person approves every one, in every approval mode.",
  };
  return {
    effect: "require_approval",
    risk: decision.risk,
    reasons: [ask, ...decision.reasons.filter((r) => !ALLOW_CODES.has(r.code))],
    expires_at: new Date(g.now.getTime() + APPROVAL_TTL_MS).toISOString(),
  };
}
