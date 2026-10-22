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
import { allowedByRuleMessage, rememberedRuleAllowed, scopeOf } from "./remember-limits.js";
import { matchingRules, type PolicyRule, type PolicyRuleSet } from "./rules.js";
import { PROMPT_EXEMPT_KOBE_TOOLS, riskClassPrompts, type PolicySettings } from "./settings.js";
import { prepareInput } from "./tool-inputs.js";

/**
 * The D29 pipeline as one pure, synchronous function:
 *
 *   site deny → team deny → site/team ask → risk class → thread approval mode →
 *   user allow rules → prompt
 *
 * - The input is checked first: built-ins against their strict Pi schema, file paths made
 *   canonical (tool-inputs.ts). Rules match the canonical view.
 * - Any deny (site rule, team rule, unavailable tool, agent `tools.deny`/`tools.allow`,
 *   connector enablement, exposure or drift) decides `deny`; all deny reasons are reported.
 * - A matching ask rule (site or team) decides `require_approval`. No allow rule removes it
 *   (decision (a)).
 * - Interactive runs (`ask-on-write`, `ask-all`): mode and risk class decide whether to ask
 *   (`ask-all`: always; `ask-on-write`: `riskClassPrompts`). **Only the user's own allow rules
 *   (approve and remember) lift that prompt** (D29: mode → user allow rules → prompt). Team allow
 *   rules never lift a prompt (D6: team rules only tighten).
 * - A user's allow rule applies only to its own calls: a `thread` rule in its thread, a `run`
 *   rule in its run (KOBE-289; the rule source has already dropped rules whose thread or run is
 *   gone), and only while the team's remember limits still allow it (remember-limits.ts).
 * - `auto` mode and scheduled runs never prompt (D29, D32): read-only tools run; anything else
 *   runs only if allow-listed by a team allow rule (the agent's `tools.allow` only narrows), else
 *   it is denied. **Remembered approvals never apply there** (KOBE-289): nobody watches an
 *   unattended run, so only the team's own allow list does. The ask-on-write sandbox switch plays
 *   no part here.
 *
 * - **Dangerous mode** (AC1, docs/specs/agent-creator.md, approved by Chris 2026-10-22): the
 *   server lists in `agent.dangerous_tools` the tools an admin's published Dangerous agent names
 *   one by one (never a glob or an empty list). Only such a tool, in an interactive (not `auto`)
 *   run, that passed every deny stage, matched no ask rule and would otherwise ask by risk class
 *   or mode, is allowed (reason `dangerous_mode`). Floors win: Kobe-scoped writes (project memory,
 *   shared project files; U10, D23, D24) keep their prompt, `auto` and scheduled runs keep
 *   their refusals (D29, D32), and the agent's own `tools.deny` is a deny like any other.
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
    ...matchingRules(rules.site, "deny", tool, view, now).map((r) =>
      ruleReason(r, "site_deny_rule", "site_deny", `${tool.name} is blocked by site policy.`),
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
    ...matchingRules(rules.site, "ask", tool, view, now).map((r) =>
      ruleReason(r, "site_ask_rule", "ask_rule", `Site policy asks before ${tool.name}.`),
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
      : tool.name === "save_skill_draft"
        ? "saves a private draft in your Workbench, which needs no approval"
        : PROMPT_EXEMPT_KOBE_TOOLS.has(tool.name)
          ? "writes a versioned artifact in this conversation, which needs no approval"
          : "writes your personal memory, which needs no approval and can be undone";
  return { code: RISK_REASON[tool.risk], stage: "risk_class", message: `${tool.name} ${where}.` };
}

/** The member's own remembered approval for this call, if one applies (interactive runs only). */
function userAllow(ctx: Prepared): PolicyReason | undefined {
  const binding = { thread_id: ctx.input.run.thread_id, run_id: ctx.input.run.run_id };
  const [rule] = matchingRules(
    ctx.rules.user,
    "allow",
    ctx.tool,
    ctx.view,
    ctx.now,
    binding,
  ).filter((r) => rememberedRuleAllowed(r, ctx.tool, ctx.rules.remember_limits, ctx.now));
  return (
    rule && ruleReason(rule, "user_allow_rule", "user_allow", allowedByRuleMessage(scopeOf(rule)))
  );
}

/** Allow-listed for auto mode / scheduled runs: a team allow rule only (never a remembered one). */
function allowListed(ctx: Prepared): PolicyReason | undefined {
  const [team] = matchingRules(ctx.rules.team, "allow", ctx.tool, ctx.view, ctx.now);
  return (
    team &&
    ruleReason(team, "team_allow_rule", "user_allow", "Allow-listed by your team for auto mode.")
  );
}

/** The reason a call is denied instead of asked when nobody may be asked; undefined if interactive. */
export function neverPromptReason(input: PolicyInput): PolicyReason | undefined {
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

/**
 * An admin's Dangerous agent (AC1): the tool is one the agent names explicitly, in an interactive
 * run, and not Kobe-scoped (those prompts are floors). Undefined otherwise.
 */
function dangerousAllow(ctx: Prepared): PolicyReason | undefined {
  if (ctx.input.actor.kind !== "user" || ctx.tool.scope === "kobe") return undefined;
  if (!ctx.input.agent.dangerous_tools.includes(ctx.tool.name)) return undefined;
  return {
    code: "dangerous_mode",
    stage: "approval_mode",
    message: `${ctx.tool.name} ran without asking: this agent is in Dangerous mode, set by an admin.`,
  };
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
      reasons: [{ code: "invalid_input", stage: "site_deny", message: prepared.message }],
    };
  }
  const p: Prepared = { ...ctx, view: prepared.view };

  const denies = denyReasons(p);
  if (denies.length > 0) return deny(p, denies);

  const never = neverPromptReason(p.input);
  const asks = askReasons(p);
  if (asks.length > 0) return never ? deny(p, [never, ...asks]) : ask(p, asks);
  // Unattended refusals are floors: Dangerous never turns them into allow (AC1).
  if (never) return decideUnattended(p, never);

  const prompts = promptReasons(p);
  if (prompts.length === 0) return allow(p, [noPromptReason(p)]);
  const own = userAllow(p);
  if (own) return allow(p, [own, ...prompts]);
  // Only where the call would otherwise ask: calls that run anyway keep their own reason.
  const dangerous = dangerousAllow(p);
  return dangerous ? allow(p, [dangerous, ...prompts]) : ask(p, prompts);
}
