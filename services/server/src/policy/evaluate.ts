import {
  APPROVAL_TTL_MS,
  type JsonObject,
  type PolicyDecision,
  type PolicyInput,
  type PolicyReason,
  type RiskClass,
  type ToolDescriptor,
} from "@kobe/protocol";
import { checkAgentTools, checkConnector, type ConnectorPolicyState } from "./gates.js";
import {
  BUILTIN_ALLOW_RULES,
  matchingRules,
  type PolicyRule,
  type PolicyRuleSet,
} from "./rules.js";
import { modeNeverPrompts, riskClassPrompts, type PolicySettings } from "./settings.js";

/**
 * The D29 pipeline as one pure, synchronous function:
 *
 *   install deny → team deny → install/team ask → risk class → thread approval mode →
 *   user allow rules → prompt
 *
 * - Any deny (install rule, team rule, agent `tools.deny`/`tools.allow`, connector enablement,
 *   exposure or drift) decides `deny`. All matching deny reasons are reported, most significant
 *   first.
 * - A matching ask rule (install or team) decides `require_approval`. **Allow rules cannot remove
 *   it** (KOBE-35 decision (a)): the floor and team policy only tighten.
 * - Otherwise risk class and mode decide whether the call needs asking: `ask-all` asks for
 *   everything; `ask-on-write` and `auto` ask by `riskClassPrompts` (settings.ts).
 * - A user allow rule (also team allow rules and built-in allow rules) removes only a prompt that
 *   came from risk class or mode.
 * - `auto` mode and scheduled runs never return `require_approval`: whatever would prompt is
 *   denied, with the reason it would have prompted (D29, D32).
 *
 * `tool` is the server's own descriptor (registry), never one built from what the sandbox sent.
 */
export interface EvaluationContext {
  readonly input: PolicyInput;
  readonly tool: ToolDescriptor;
  readonly rules: PolicyRuleSet;
  /** Team connector state for MCP tools (undefined: not enabled in this team). */
  readonly connector: ConnectorPolicyState | undefined;
  readonly settings: PolicySettings;
  readonly now: Date;
}

const RISK_REASON = {
  read: "risk_read",
  write: "risk_write",
  destructive: "risk_destructive",
} as const satisfies Record<RiskClass, PolicyReason["code"]>;

const RISK_LABEL: Readonly<Record<RiskClass, string>> = {
  read: "reads data",
  write: "changes data",
  destructive: "can change or delete data",
};

function ruleReason(
  rule: PolicyRule,
  code: PolicyReason["code"],
  stage: PolicyReason["stage"],
  message: string,
): PolicyReason {
  return { code, stage, message, ...(rule.id !== undefined ? { rule_id: rule.id } : {}) };
}

function denyReasons(ctx: EvaluationContext): PolicyReason[] {
  const { tool, rules, now } = ctx;
  const input: JsonObject = ctx.input.input;
  return [
    ...matchingRules(rules.install, "deny", tool, input, now).map((r) =>
      ruleReason(
        r,
        "install_deny_rule",
        "install_deny",
        `${tool.name} is blocked by install policy.`,
      ),
    ),
    ...matchingRules(rules.team, "deny", tool, input, now).map((r) =>
      ruleReason(r, "team_deny_rule", "team_deny", `${tool.name} is blocked by team policy.`),
    ),
    ...checkAgentTools(ctx.input.agent, tool, input),
    ...checkConnector(ctx.input, tool, ctx.connector),
  ];
}

function askReasons(ctx: EvaluationContext): PolicyReason[] {
  const { tool, rules, now } = ctx;
  const input: JsonObject = ctx.input.input;
  return [
    ...matchingRules(rules.install, "ask", tool, input, now).map((r) =>
      ruleReason(r, "install_ask_rule", "ask_rule", `Install policy asks before ${tool.name}.`),
    ),
    ...matchingRules(rules.team, "ask", tool, input, now).map((r) =>
      ruleReason(r, "team_ask_rule", "ask_rule", `Team policy asks before ${tool.name}.`),
    ),
  ];
}

/** Why risk class or mode would prompt for this call; empty = no prompt. */
function promptReasons(ctx: EvaluationContext): PolicyReason[] {
  const { tool } = ctx;
  if (ctx.input.run.approval_mode === "ask-all") {
    return [
      {
        code: "mode_ask_all",
        stage: "approval_mode",
        message: `This thread asks before every tool call (${tool.name}).`,
      },
    ];
  }
  if (!riskClassPrompts(tool, ctx.settings)) return [];
  return [
    {
      code: RISK_REASON[tool.risk],
      stage: "risk_class",
      message: `${tool.name} ${RISK_LABEL[tool.risk]}; this thread asks before writes.`,
    },
  ];
}

/** Why nothing prompted: shown on allowed calls. */
function noPromptReason(ctx: EvaluationContext): PolicyReason {
  const { tool } = ctx;
  if (tool.risk === "read") {
    return { code: "risk_read", stage: "risk_class", message: `${tool.name} only reads data.` };
  }
  return {
    code: RISK_REASON[tool.risk],
    stage: "risk_class",
    message: `${tool.name} runs inside your sandbox, bounded by the sandbox and egress policy.`,
  };
}

function allowRule(ctx: EvaluationContext): PolicyReason | undefined {
  const { tool, rules, now } = ctx;
  const input: JsonObject = ctx.input.input;
  const [user] = matchingRules(rules.user, "allow", tool, input, now);
  if (user) return ruleReason(user, "user_allow_rule", "user_allow", "You allowed this earlier.");
  const [team] = matchingRules(rules.team, "allow", tool, input, now);
  if (team) return ruleReason(team, "user_allow_rule", "user_allow", "Allowed by a team rule.");
  const [builtin] = matchingRules(BUILTIN_ALLOW_RULES, "allow", tool, input, now);
  if (builtin) {
    return ruleReason(builtin, "user_allow_rule", "user_allow", builtin.message ?? "Allowed.");
  }
  return undefined;
}

/** The reason a call that would prompt is denied instead, when nobody may be asked. */
function neverPromptReason(input: PolicyInput): PolicyReason | undefined {
  if (input.actor.kind === "schedule") {
    return {
      code: "scheduled_run_no_prompt",
      stage: "prompt",
      message: "Scheduled runs don't wait for approval; this call was skipped.",
    };
  }
  if (modeNeverPrompts(input.run.approval_mode)) {
    return {
      code: "mode_auto_not_allowlisted",
      stage: "approval_mode",
      message: "Auto mode runs only allow-listed tools; this call was denied.",
    };
  }
  return undefined;
}

function prompt(ctx: EvaluationContext, reasons: PolicyReason[]): PolicyDecision {
  const never = neverPromptReason(ctx.input);
  const risk = ctx.tool.risk;
  if (never) return { effect: "deny", risk, reasons: [never, ...reasons] };
  const expires_at = new Date(ctx.now.getTime() + APPROVAL_TTL_MS).toISOString();
  return { effect: "require_approval", risk, reasons, expires_at };
}

export function evaluatePolicy(ctx: EvaluationContext): PolicyDecision {
  const risk = ctx.tool.risk;
  const denies = denyReasons(ctx);
  if (denies.length > 0) return { effect: "deny", risk, reasons: denies };

  const asks = askReasons(ctx);
  if (asks.length > 0) return prompt(ctx, asks);

  const prompts = promptReasons(ctx);
  if (prompts.length === 0) return { effect: "allow", risk, reasons: [noPromptReason(ctx)] };

  const allowed = allowRule(ctx);
  if (allowed) return { effect: "allow", risk, reasons: [allowed, ...prompts] };
  return prompt(ctx, prompts);
}
