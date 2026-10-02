import {
  APPROVAL_TTL_MS,
  type JsonObject,
  type PolicyDecision,
  type PolicyInput,
  type PolicyReason,
  type RiskClass,
  type ToolDescriptor,
} from "@kobe/protocol";
import {
  checkAgentTools,
  checkAvailable,
  checkConnector,
  type ConnectorPolicyState,
} from "./gates.js";
import { matchingRules, type PolicyRule, type PolicyRuleSet } from "./rules.js";
import { riskClassPrompts, type PolicySettings } from "./settings.js";
import { prepareInput } from "./tool-inputs.js";

/**
 * The D29 pipeline as one pure, synchronous function:
 *
 *   install deny → team deny → install/team ask → risk class → thread approval mode →
 *   user allow rules → prompt
 *
 * - The input is checked first: built-ins against their strict Pi schema, file paths made
 *   canonical (tool-inputs.ts). Rules match the canonical view.
 * - Any deny (install rule, team rule, unavailable tool, agent `tools.deny`/`tools.allow`,
 *   connector enablement, exposure or drift) decides `deny`; all deny reasons are reported.
 * - A matching ask rule (install or team) decides `require_approval`. No allow rule removes it
 *   (decision (a)).
 * - Interactive runs (`ask-on-write`, `ask-all`): mode and risk class decide whether to ask
 *   (`ask-all`: always; `ask-on-write`: `riskClassPrompts`). **Only the user's own allow rules
 *   (approve and remember) lift that prompt** (D29: mode → user allow rules → prompt). Team allow
 *   rules never lift a prompt (D6: team rules only tighten).
 * - `auto` mode and scheduled runs never prompt (D29, D32): read-only tools run; anything else
 *   runs only if allow-listed by a user or team allow rule (the agent's `tools.allow` only
 *   narrows), else it is denied. The ask-on-write sandbox switch plays no part here.
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

/** The context plus the prepared (validated, canonical-path) input rules match against. */
interface Prepared extends EvaluationContext {
  readonly view: JsonObject;
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
  return { code, stage, message, rule_id: rule.id };
}

function denyReasons(ctx: Prepared): PolicyReason[] {
  const { tool, rules, now, view } = ctx;
  return [
    ...matchingRules(rules.install, "deny", tool, view, now).map((r) =>
      ruleReason(
        r,
        "install_deny_rule",
        "install_deny",
        `${tool.name} is blocked by install policy.`,
      ),
    ),
    ...matchingRules(rules.team, "deny", tool, view, now).map((r) =>
      ruleReason(r, "team_deny_rule", "team_deny", `${tool.name} is blocked by team policy.`),
    ),
    ...checkAvailable(tool),
    ...checkAgentTools(ctx.input.agent, tool, view),
    ...checkConnector(ctx.input, tool, ctx.connector),
  ];
}

function askReasons(ctx: Prepared): PolicyReason[] {
  const { tool, rules, now, view } = ctx;
  return [
    ...matchingRules(rules.install, "ask", tool, view, now).map((r) =>
      ruleReason(r, "install_ask_rule", "ask_rule", `Install policy asks before ${tool.name}.`),
    ),
    ...matchingRules(rules.team, "ask", tool, view, now).map((r) =>
      ruleReason(r, "team_ask_rule", "ask_rule", `Team policy asks before ${tool.name}.`),
    ),
  ];
}

function riskReason(tool: ToolDescriptor, suffix: string): PolicyReason {
  return {
    code: RISK_REASON[tool.risk],
    stage: "risk_class",
    message: `${tool.name} ${RISK_LABEL[tool.risk]}${suffix}`,
  };
}

/** Why an interactive run would prompt for this call; empty = no prompt. */
function promptReasons(ctx: Prepared): PolicyReason[] {
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
  if (!riskClassPrompts(tool, ctx.view, ctx.settings)) return [];
  return [riskReason(tool, "; this thread asks before writes.")];
}

/** Why nothing prompted: shown on allowed calls. */
function noPromptReason(ctx: Prepared): PolicyReason {
  const { tool } = ctx;
  if (tool.risk === "read") {
    return { code: "risk_read", stage: "risk_class", message: `${tool.name} only reads data.` };
  }
  const where =
    tool.scope === "sandbox"
      ? "runs inside your sandbox, bounded by the sandbox and egress policy"
      : "writes your personal memory, which needs no approval and can be undone";
  return { code: RISK_REASON[tool.risk], stage: "risk_class", message: `${tool.name} ${where}.` };
}

function userAllow(ctx: Prepared): PolicyReason | undefined {
  const [rule] = matchingRules(ctx.rules.user, "allow", ctx.tool, ctx.view, ctx.now);
  return rule && ruleReason(rule, "user_allow_rule", "user_allow", "You allowed this earlier.");
}

/** Allow-listed for auto mode / scheduled runs: the user's own rule, else a team allow rule. */
function allowListed(ctx: Prepared): PolicyReason | undefined {
  const own = userAllow(ctx);
  if (own) return own;
  const [team] = matchingRules(ctx.rules.team, "allow", ctx.tool, ctx.view, ctx.now);
  return (
    team &&
    ruleReason(team, "user_allow_rule", "user_allow", "Allow-listed by your team for auto mode.")
  );
}

/** The reason a call is denied instead of asked when nobody may be asked; undefined if interactive. */
function neverPromptReason(input: PolicyInput): PolicyReason | undefined {
  if (input.actor.kind === "schedule") {
    return {
      code: "scheduled_run_no_prompt",
      stage: "prompt",
      message: "Scheduled runs only run allow-listed and read-only tools; this call was skipped.",
    };
  }
  if (input.run.approval_mode === "auto") {
    return {
      code: "mode_auto_not_allowlisted",
      stage: "approval_mode",
      message: "Auto mode runs only allow-listed and read-only tools; this call was denied.",
    };
  }
  return undefined;
}

function deny(ctx: Prepared, reasons: PolicyReason[]): PolicyDecision {
  return { effect: "deny", risk: ctx.tool.risk, reasons };
}

function ask(ctx: Prepared, reasons: PolicyReason[]): PolicyDecision {
  const expires_at = new Date(ctx.now.getTime() + APPROVAL_TTL_MS).toISOString();
  return { effect: "require_approval", risk: ctx.tool.risk, reasons, expires_at };
}

function allow(ctx: Prepared, reasons: PolicyReason[]): PolicyDecision {
  return { effect: "allow", risk: ctx.tool.risk, reasons };
}

/** `auto` / scheduled: never prompt; read-only or allow-listed, else deny. */
function decideUnattended(ctx: Prepared, never: PolicyReason): PolicyDecision {
  if (ctx.tool.risk === "read") return allow(ctx, [noPromptReason(ctx)]);
  const listed = allowListed(ctx);
  if (listed) return allow(ctx, [listed]);
  return deny(ctx, [never, riskReason(ctx.tool, " and is not allow-listed.")]);
}

export function evaluatePolicy(ctx: EvaluationContext): PolicyDecision {
  const prepared = prepareInput(ctx.tool, ctx.input.input);
  if (!prepared.ok) {
    return {
      effect: "deny",
      risk: ctx.tool.risk,
      reasons: [{ code: "invalid_input", stage: "install_deny", message: prepared.message }],
    };
  }
  const p: Prepared = { ...ctx, view: prepared.view };

  const denies = denyReasons(p);
  if (denies.length > 0) return deny(p, denies);

  const never = neverPromptReason(p.input);
  const asks = askReasons(p);
  if (asks.length > 0) return never ? deny(p, [never, ...asks]) : ask(p, asks);
  if (never) return decideUnattended(p, never);

  const prompts = promptReasons(p);
  if (prompts.length === 0) return allow(p, [noPromptReason(p)]);
  const own = userAllow(p);
  return own ? allow(p, [own, ...prompts]) : ask(p, prompts);
}
