import { z } from "zod";
import {
  approvalModeSchema,
  idSchema,
  riskClassSchema,
  runTriggerSchema,
  timestampSchema,
  toolInputSchema,
  uuidSchema,
} from "./common.js";
import { argPatternSchema, globSchema } from "./glob.js";
import { toolDescriptorSchema } from "./tools.js";

/**
 * Policy decision contract (D29). The policy engine (KOBE-35) decides every tool call; the
 * `kobe-policy` Pi extension (KOBE-36) asks through the sandbox wire (`policy.check`), the MCP proxy
 * (KOBE-58) asks again before calling upstream, approvals (KOBE-37) resolve `require_approval`,
 * schedules (KOBE-65) run in `auto` mode.
 *
 * Evaluation order (D29):
 *   install deny → team deny → install/team ask → risk class → thread approval mode →
 *   user allow rules → prompt
 * Reading of that order used by this contract (KOBE-35 to confirm): a matching deny rule decides
 * `deny`; a matching ask rule decides `require_approval` (user allow rules cannot remove it); risk
 * class and mode decide whether the call needs asking; a user allow rule can only remove a prompt
 * that comes from risk class or mode; whatever remains is prompted. There is no bypass: no mode,
 * flag, or role skips this pipeline. Unknown tools are denied before any of it (tools.ts).
 *
 * Patterns in rules use the glob grammar in glob.ts — never regular expressions.
 */
export const POLICY_EVALUATION_ORDER = [
  "install_deny",
  "team_deny",
  "ask_rule",
  "risk_class",
  "approval_mode",
  "user_allow",
  "prompt",
] as const;
export type PolicyStage = (typeof POLICY_EVALUATION_ORDER)[number];

/** The thing being decided. Built by the server from its own state; `tool` from its registry. */
export const policyInputSchema = z
  .strictObject({
    actor: z.strictObject({
      user_id: uuidSchema,
      /** `schedule` for scheduled runs (D32): executes as the user, but never prompts. */
      kind: runTriggerSchema,
    }),
    team_id: uuidSchema,
    agent: z.strictObject({
      /** Null (with `version`) = the install default agent (threads.agent_id is nullable). */
      agent_id: uuidSchema.nullable(),
      version: z.number().int().positive().nullable(),
      /** Agent frontmatter `tools.allow` / `tools.deny` (D19), glob grammar. */
      tools_allow: z.array(z.string()).default([]),
      tools_deny: z.array(z.string()).default([]),
    }),
    run: z.strictObject({
      run_id: uuidSchema,
      thread_id: uuidSchema,
      /** Effective mode after intersecting agent, thread and floor (never looser than the floor). */
      approval_mode: approvalModeSchema,
    }),
    /** Server-derived (tools.ts). Never built from anything the sandbox sent besides the name. */
    tool: toolDescriptorSchema,
    tool_call_id: idSchema,
    /** Set for nested calls (Pi assigns `<parent id>/<n>`; verified Pi 1.0.0). */
    parent_tool_call_id: idSchema.optional(),
    /** Tool input as parsed JSON; the canonical form is `canonicalJson(input)`. */
    input: toolInputSchema,
    context: z.strictObject({
      /** Which enforcement point is asking. The MCP proxy re-checks every MCP call (D27, D29). */
      enforcement_point: z.enum(["sandbox", "mcp_proxy"]),
      project_id: uuidSchema.optional(),
      /** MCP connector exposure in the team (D27); required when `tool.source` is `mcp`. */
      connector_exposure: z.enum(["read_only", "all", "custom"]).optional(),
    }),
  })
  .superRefine((value, ctx) => {
    // MCP calls are decided against the team's connector state (D27): both must be present.
    if (value.tool.source !== "mcp") return;
    if (value.tool.connector_id === undefined) {
      ctx.addIssue({ code: "custom", path: ["tool", "connector_id"], message: "required for mcp" });
    }
    if (value.context.connector_exposure === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["context", "connector_exposure"],
        message: "required for mcp",
      });
    }
  });
export type PolicyInput = z.infer<typeof policyInputSchema>;

/** Stable reason codes, one per stage outcome; `message` is shown on cards and in tool errors. */
export const POLICY_REASON_CODES = [
  "unknown_tool", // not built in and not in a pinned connector snapshot → deny
  "invalid_input", // input fails toolInputSchema (U+0000, __proto__, unsafe integer) → deny
  "install_deny_rule",
  "team_deny_rule",
  "agent_tool_deny",
  "connector_not_enabled",
  "connector_exposure",
  "tool_drifted", // MCP tool changed since pinned; disabled until re-approved (D27)
  "install_ask_rule",
  "team_ask_rule",
  "risk_read",
  "risk_write",
  "risk_destructive",
  "mode_ask_all",
  "mode_ask_on_write",
  "mode_auto_not_allowlisted", // auto: anything not allow-listed is denied, not prompted
  "scheduled_run_no_prompt", // D32: deny-don't-wait
  "user_allow_rule",
  "approval_granted", // a valid signed approval exists for this exact call
  "budget_exhausted", // D30: pending approvals expire at 100 %
  "default_prompt",
] as const;
export const policyReasonCodeSchema = z.enum(POLICY_REASON_CODES);
export type PolicyReasonCode = z.infer<typeof policyReasonCodeSchema>;

export const policyReasonSchema = z.strictObject({
  code: policyReasonCodeSchema,
  stage: z.enum(POLICY_EVALUATION_ORDER),
  message: z.string().max(1000),
  /** `tool_rules.id` when a rule matched. */
  rule_id: uuidSchema.optional(),
});
export type PolicyReason = z.infer<typeof policyReasonSchema>;

const decisionBase = {
  risk: riskClassSchema,
  /** Most significant reason first. Never empty. */
  reasons: z.array(policyReasonSchema).min(1),
};

export const policyDecisionSchema = z.discriminatedUnion("effect", [
  z.strictObject({ effect: z.literal("allow"), ...decisionBase }),
  z.strictObject({ effect: z.literal("deny"), ...decisionBase }),
  z.strictObject({
    effect: z.literal("require_approval"),
    ...decisionBase,
    /** When the pending approval expires (now + 1 h, D29). */
    expires_at: timestampSchema,
  }),
]);
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export type PolicyEffect = PolicyDecision["effect"];

export interface PolicyEngine {
  /**
   * Decide one tool call. Must fail closed (deny) on any internal error. Must never return
   * `require_approval` when `run.approval_mode` is `auto` or `actor.kind` is `schedule`.
   */
  decide(input: PolicyInput): Promise<PolicyDecision>;
}

/** A remember-rule as the user submits it with an approval (§6.1). */
export const rememberRuleSchema = z.strictObject({
  tool_glob: globSchema,
  arg_pattern: argPatternSchema.optional(),
  /** Seconds until the rule expires; absent = until revoked. */
  expires_in: z
    .number()
    .int()
    .positive()
    .max(366 * 24 * 3600)
    .optional(),
});

/** §6.1 `POST /v1/approvals/{id}` body. */
export const approvalResolutionBodySchema = z.strictObject({
  decision: z.enum(["allow", "deny"]),
  remember: rememberRuleSchema.optional(),
});
export type ApprovalResolutionBody = z.infer<typeof approvalResolutionBodySchema>;

/** `approvals.status` (spec §5.4). */
export const approvalStatusSchema = z.enum(["pending", "allowed", "denied", "expired"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/**
 * Why an approval left `pending`. When a run ends while an approval is pending (Stop, sandbox lost,
 * budget, run failed), the approval becomes `expired` with that cause and an `approval.resolved`
 * event is written before the run's terminal event.
 */
export const APPROVAL_RESOLUTION_CAUSES = [
  "user", // a human allowed or denied it
  "ttl", // 1 h passed (D29) → expired, run fails
  "run_cancelled",
  "run_interrupted",
  "budget_exhausted",
  "run_failed",
] as const;
export const approvalResolutionCauseSchema = z.enum(APPROVAL_RESOLUTION_CAUSES);
export type ApprovalResolutionCause = z.infer<typeof approvalResolutionCauseSchema>;

/** `tool_rules` row shape (spec §5.4), as the engine reads it. Storage is KOBE-35's (jsonb arg_pattern). */
export const toolRuleSchema = z.strictObject({
  id: uuidSchema,
  scope: z.enum(["install", "team", "user"]),
  scope_ref: uuidSchema,
  effect: z.enum(["deny", "ask", "allow"]),
  tool_glob: globSchema,
  arg_pattern: argPatternSchema.optional(),
  expires_at: timestampSchema.optional(),
});
export type ToolRule = z.infer<typeof toolRuleSchema>;
