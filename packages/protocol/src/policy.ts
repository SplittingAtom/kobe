import { z } from "zod";
import {
  approvalModeSchema,
  idSchema,
  jsonObjectSchema,
  riskClassSchema,
  runTriggerSchema,
  timestampSchema,
  type RiskClass,
} from "./common.js";

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
 * flag, or role skips this pipeline.
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

/** MCP tool annotations (MCP 2025-11-25 / 2026-07-28 hint names; verified in Pi 1.0.0 too). */
export const toolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type ToolAnnotations = z.infer<typeof toolAnnotationsSchema>;

/**
 * Where a tool comes from. `pi` = Pi built-ins (bash, read, edit, write, grep, find, ls);
 * `kobe` = kobe-tools extension (create_artifact, update_artifact, share_file, remember, recall);
 * `mcp` = a connector tool through the MCP proxy; `skill` = reserved for skill-provided tools.
 */
export const toolSourceSchema = z.enum(["pi", "kobe", "mcp", "skill"]);
export type ToolSource = z.infer<typeof toolSourceSchema>;

export const toolDescriptorSchema = z.object({
  /** Tool name as Pi sees it, e.g. `bash`, `mcp__jira__create_issue`. */
  name: z.string().min(1).max(256),
  source: toolSourceSchema,
  /** Registry id of the MCP connector when `source` is `mcp`. */
  connector_id: idSchema.optional(),
  annotations: toolAnnotationsSchema.default({}),
});
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;

/** The thing being decided. Built by the server from its own state plus the sandbox's request. */
export const policyInputSchema = z.object({
  actor: z.object({
    user_id: idSchema,
    /** `schedule` for scheduled runs (D32): executes as the user, but never prompts. */
    kind: runTriggerSchema,
  }),
  team_id: idSchema,
  agent: z.object({
    agent_id: idSchema,
    version: z.number().int().positive(),
    /** Agent frontmatter `tools.allow` / `tools.deny` globs (D19). */
    tools_allow: z.array(z.string()).default([]),
    tools_deny: z.array(z.string()).default([]),
  }),
  run: z.object({
    run_id: idSchema,
    thread_id: idSchema,
    /** Effective mode after intersecting agent, thread and floor (never looser than the floor). */
    approval_mode: approvalModeSchema,
  }),
  tool: toolDescriptorSchema,
  tool_call_id: idSchema,
  /** Set for nested calls (Pi assigns `<parent id>/<n>`; verified Pi 1.0.0). */
  parent_tool_call_id: idSchema.optional(),
  /** Tool input as parsed JSON; the canonical form is `canonicalJson(input)`. */
  input: jsonObjectSchema,
  context: z.object({
    /** Which enforcement point is asking. The MCP proxy re-checks every MCP call (D27, D29). */
    enforcement_point: z.enum(["sandbox", "mcp_proxy"]),
    project_id: idSchema.optional(),
    /** MCP connector exposure in the team (D27); required when `tool.source` is `mcp`. */
    connector_exposure: z.enum(["read_only", "all", "custom"]).optional(),
  }),
});
export type PolicyInput = z.infer<typeof policyInputSchema>;

/** Stable reason codes, one per stage outcome; `message` is shown on cards and in tool errors. */
export const POLICY_REASON_CODES = [
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

export const policyReasonSchema = z.object({
  code: policyReasonCodeSchema,
  stage: z.enum(POLICY_EVALUATION_ORDER),
  message: z.string().max(1000),
  /** `tool_rules.id` when a rule matched. */
  rule_id: idSchema.optional(),
});
export type PolicyReason = z.infer<typeof policyReasonSchema>;

const decisionBase = {
  risk: riskClassSchema,
  /** Most significant reason first. Never empty. */
  reasons: z.array(policyReasonSchema).min(1),
};

export const policyDecisionSchema = z.discriminatedUnion("effect", [
  z.object({ effect: z.literal("allow"), ...decisionBase }),
  z.object({ effect: z.literal("deny"), ...decisionBase }),
  z.object({
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

/**
 * D29 risk rule: readOnly → read; explicit destructive or missing hints → destructive (unannotated
 * = destructive + open-world); otherwise write.
 */
export function riskFromAnnotations(annotations: ToolAnnotations): RiskClass {
  if (annotations.readOnlyHint === true) return "read";
  if (annotations.destructiveHint === false) return "write";
  return "destructive";
}

/** Unannotated tools count as open-world (MCP default). */
export function isOpenWorld(annotations: ToolAnnotations): boolean {
  return annotations.openWorldHint ?? true;
}

/** §6.1 `POST /v1/approvals/{id}` body. `expires_in` is seconds until the remember-rule expires. */
export const approvalResolutionBodySchema = z.object({
  decision: z.enum(["allow", "deny"]),
  remember: z
    .object({
      tool_glob: z.string().min(1).max(256),
      arg_pattern: z.string().min(1).max(1000).optional(),
      expires_in: z.number().int().positive().optional(),
    })
    .optional(),
});
export type ApprovalResolutionBody = z.infer<typeof approvalResolutionBodySchema>;

/** `approvals.status` (spec §5.4). */
export const approvalStatusSchema = z.enum(["pending", "allowed", "denied", "expired"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/** `tool_rules` row shape (spec §5.4), as the engine reads it. Storage is KOBE-35's. */
export const toolRuleSchema = z.object({
  id: idSchema,
  scope: z.enum(["install", "team", "user"]),
  scope_ref: idSchema,
  effect: z.enum(["deny", "ask", "allow"]),
  tool_glob: z.string().min(1).max(256),
  arg_pattern: z.string().min(1).max(1000).optional(),
  expires_at: timestampSchema.optional(),
});
export type ToolRule = z.infer<typeof toolRuleSchema>;
