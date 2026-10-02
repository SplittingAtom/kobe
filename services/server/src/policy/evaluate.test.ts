import { describe, expect, it } from "vitest";
import {
  APPROVAL_MODES,
  BUILTIN_TOOLS,
  policyDecisionSchema,
  type JsonObject,
  type PolicyDecision,
  type ToolDescriptor,
} from "@kobe/protocol";
import {
  builtin,
  ENABLED_ALL,
  mcpTool,
  NOW,
  policyInput,
  rule,
  ruleSet,
  type InputOptions,
} from "../testing/policy-fixtures.js";
import { evaluatePolicy } from "./evaluate.js";
import type { ConnectorPolicyState } from "./gates.js";
import type { PolicyRule } from "./rules.js";
import { DEFAULT_POLICY_SETTINGS, type PolicySettings } from "./settings.js";

interface Case {
  readonly name: string;
  readonly tool: ToolDescriptor;
  readonly input?: JsonObject;
  readonly options?: InputOptions;
  readonly rules?: readonly PolicyRule[];
  readonly connector?: ConnectorPolicyState;
  readonly settings?: PolicySettings;
  readonly effect: PolicyDecision["effect"];
  /** Reason codes, in order. */
  readonly codes: readonly string[];
}

function run(c: Omit<Case, "name" | "effect" | "codes">): PolicyDecision {
  const decision = evaluatePolicy({
    input: policyInput(c.tool, c.input ?? {}, c.options ?? {}),
    tool: c.tool,
    rules: ruleSet(c.rules ?? []),
    connector: c.connector ?? (c.tool.source === "mcp" ? ENABLED_ALL : undefined),
    settings: c.settings ?? DEFAULT_POLICY_SETTINGS,
    now: NOW,
  });
  // Every decision satisfies the published contract.
  expect(policyDecisionSchema.parse(decision)).toEqual(decision);
  return decision;
}

const bash = builtin("bash");
const read = builtin("read");
const write = builtin("write");
const artifact = builtin("create_artifact");
const jiraCreate = mcpTool("mcp__jira__create_issue", "write");
const jiraSearch = mcpTool("mcp__jira__search", "read");
const PROMPT_SANDBOX: PolicySettings = { promptSandboxWrites: true };

// Each row isolates one layer of the D29 order winning or losing against the layers after it.
const CASES: readonly Case[] = [
  // 1. install deny wins over everything after it.
  {
    name: "install deny beats team allow, user allow and a read-only tool",
    tool: read,
    rules: [
      rule("install", "deny", "read"),
      rule("team", "allow", "read"),
      rule("user", "allow", "read"),
    ],
    effect: "deny",
    codes: ["install_deny_rule"],
  },
  {
    name: "install deny reports before team deny when both match",
    tool: bash,
    rules: [rule("team", "deny", "bash"), rule("install", "deny", "ba*")],
    effect: "deny",
    codes: ["install_deny_rule", "team_deny_rule"],
  },
  {
    name: "install deny with arg pattern only denies matching input",
    tool: bash,
    input: { command: "ls -la" },
    rules: [rule("install", "deny", "bash", { arg_pattern: { "/command": "rm *" } })],
    effect: "allow",
    codes: ["risk_destructive"],
  },
  {
    name: "install deny with arg pattern denies matching input",
    tool: bash,
    input: { command: "rm -rf /" },
    rules: [rule("install", "deny", "bash", { arg_pattern: { "/command": "rm *" } })],
    effect: "deny",
    codes: ["install_deny_rule"],
  },
  // 2. team deny wins over ask, risk, mode and allow.
  {
    name: "team deny beats install ask and user allow",
    tool: artifact,
    rules: [
      rule("install", "ask", "create_artifact"),
      rule("team", "deny", "create_*"),
      rule("user", "allow", "create_artifact"),
    ],
    effect: "deny",
    codes: ["team_deny_rule"],
  },
  {
    name: "expired deny rules are ignored",
    tool: read,
    rules: [rule("install", "deny", "read", { expires_at: "2026-10-02T11:59:59.000Z" })],
    effect: "allow",
    codes: ["risk_read"],
  },
  // 3. ask rules: user/team allow can't remove them (decision (a)).
  {
    name: "install ask on a read-only tool prompts",
    tool: read,
    rules: [rule("install", "ask", "read")],
    effect: "require_approval",
    codes: ["install_ask_rule"],
  },
  {
    name: "user allow cannot remove an install ask",
    tool: write,
    rules: [rule("install", "ask", "write"), rule("user", "allow", "write")],
    effect: "require_approval",
    codes: ["install_ask_rule"],
  },
  {
    name: "user allow cannot remove a team ask",
    tool: artifact,
    rules: [rule("team", "ask", "create_artifact"), rule("user", "allow", "create_artifact")],
    effect: "require_approval",
    codes: ["team_ask_rule"],
  },
  {
    name: "team allow cannot remove a team ask",
    tool: jiraCreate,
    rules: [rule("team", "ask", "mcp__jira__*"), rule("team", "allow", "mcp__jira__*")],
    effect: "require_approval",
    codes: ["team_ask_rule"],
  },
  {
    name: "both ask rules are reported, install first",
    tool: bash,
    rules: [rule("team", "ask", "bash"), rule("install", "ask", "bash")],
    effect: "require_approval",
    codes: ["install_ask_rule", "team_ask_rule"],
  },
  {
    name: "ask rule in auto mode denies instead of prompting",
    tool: read,
    options: { mode: "auto" },
    rules: [rule("team", "ask", "read")],
    effect: "deny",
    codes: ["mode_auto_not_allowlisted", "team_ask_rule"],
  },
  {
    name: "ask rule in a scheduled run denies instead of prompting",
    tool: read,
    options: { mode: "auto", kind: "schedule" },
    rules: [rule("install", "ask", "read"), rule("user", "allow", "read")],
    effect: "deny",
    codes: ["scheduled_run_no_prompt", "install_ask_rule"],
  },
  // 4. risk class (ask-on-write).
  {
    name: "ask-on-write allows read-only tools",
    tool: read,
    effect: "allow",
    codes: ["risk_read"],
  },
  {
    name: "ask-on-write prompts for a Kobe-scoped write",
    tool: artifact,
    effect: "require_approval",
    codes: ["risk_write"],
  },
  {
    name: "ask-on-write prompts for an external write",
    tool: jiraCreate,
    effect: "require_approval",
    codes: ["risk_write"],
  },
  {
    name: "ask-on-write allows a read-only MCP tool",
    tool: jiraSearch,
    effect: "allow",
    codes: ["risk_read"],
  },
  {
    name: "ask-on-write: sandbox-scoped bash is not prompted by risk class (switch off)",
    tool: bash,
    effect: "allow",
    codes: ["risk_destructive"],
  },
  {
    name: "ask-on-write: sandbox-scoped write is prompted when the switch is on",
    tool: write,
    settings: PROMPT_SANDBOX,
    effect: "require_approval",
    codes: ["risk_write"],
  },
  {
    name: "ask-on-write: sandbox-scoped bash is prompted when the switch is on",
    tool: bash,
    settings: PROMPT_SANDBOX,
    effect: "require_approval",
    codes: ["risk_destructive"],
  },
  // 5. thread approval mode.
  {
    name: "ask-all prompts even for a read-only tool",
    tool: read,
    options: { mode: "ask-all" },
    effect: "require_approval",
    codes: ["mode_ask_all"],
  },
  {
    name: "ask-all prompts for sandbox tools whatever the switch",
    tool: bash,
    options: { mode: "ask-all" },
    effect: "require_approval",
    codes: ["mode_ask_all"],
  },
  {
    name: "auto allows read-only tools",
    tool: read,
    options: { mode: "auto" },
    effect: "allow",
    codes: ["risk_read"],
  },
  {
    name: "auto denies a write that would prompt",
    tool: artifact,
    options: { mode: "auto" },
    effect: "deny",
    codes: ["mode_auto_not_allowlisted", "risk_write"],
  },
  {
    name: "auto denies sandbox writes when the switch makes them prompt",
    tool: bash,
    options: { mode: "auto" },
    settings: PROMPT_SANDBOX,
    effect: "deny",
    codes: ["mode_auto_not_allowlisted", "risk_destructive"],
  },
  {
    name: "scheduled run in ask-on-write still never prompts",
    tool: jiraCreate,
    options: { mode: "ask-on-write", kind: "schedule" },
    effect: "deny",
    codes: ["scheduled_run_no_prompt", "risk_write"],
  },
  // 6. user allow removes risk/mode prompts only.
  {
    name: "user allow removes a risk-class prompt",
    tool: jiraCreate,
    rules: [rule("user", "allow", "mcp__jira__create_issue")],
    effect: "allow",
    codes: ["user_allow_rule", "risk_write"],
  },
  {
    name: "user allow removes an ask-all prompt",
    tool: read,
    options: { mode: "ask-all" },
    rules: [rule("user", "allow", "read")],
    effect: "allow",
    codes: ["user_allow_rule", "mode_ask_all"],
  },
  {
    name: "user allow allow-lists a write in auto mode",
    tool: artifact,
    options: { mode: "auto" },
    rules: [rule("user", "allow", "create_artifact")],
    effect: "allow",
    codes: ["user_allow_rule", "risk_write"],
  },
  {
    name: "user allow allow-lists a write in a scheduled run",
    tool: jiraCreate,
    options: { mode: "auto", kind: "schedule" },
    rules: [rule("user", "allow", "mcp__jira__*")],
    effect: "allow",
    codes: ["user_allow_rule", "risk_write"],
  },
  {
    name: "user allow with a non-matching arg pattern still prompts",
    tool: jiraCreate,
    input: { project: "OPS" },
    rules: [
      rule("user", "allow", "mcp__jira__create_issue", { arg_pattern: { "/project": "KOBE" } }),
    ],
    effect: "require_approval",
    codes: ["risk_write"],
  },
  {
    name: "user allow with a matching arg pattern allows",
    tool: jiraCreate,
    input: { project: "KOBE", summary: "x" },
    rules: [
      rule("user", "allow", "mcp__jira__create_issue", { arg_pattern: { "/project": "KOBE" } }),
    ],
    effect: "allow",
    codes: ["user_allow_rule", "risk_write"],
  },
  {
    name: "expired user allow is ignored",
    tool: artifact,
    rules: [rule("user", "allow", "create_artifact", { expires_at: NOW.toISOString() })],
    effect: "require_approval",
    codes: ["risk_write"],
  },
  {
    name: "a blanket user allow rule is ignored (no bypass)",
    tool: artifact,
    options: { mode: "auto" },
    rules: [rule("user", "allow", "*"), rule("team", "allow", "create_*")],
    effect: "deny",
    codes: ["mode_auto_not_allowlisted", "risk_write"],
  },
  {
    name: "team allow removes a risk-class prompt",
    tool: artifact,
    rules: [rule("team", "allow", "create_artifact")],
    effect: "allow",
    codes: ["user_allow_rule", "risk_write"],
  },
  // 7. built-in allow (D24): personal remember needs no approval; project memory asks.
  {
    name: "personal remember is allowed by the built-in rule",
    tool: builtin("remember"),
    input: { scope: "personal", content: "likes tea" },
    effect: "allow",
    codes: ["user_allow_rule", "risk_write"],
  },
  {
    name: "project remember prompts",
    tool: builtin("remember"),
    input: { scope: "project", content: "x" },
    effect: "require_approval",
    codes: ["risk_write"],
  },
  {
    name: "remember without a scope prompts (fail closed)",
    tool: builtin("remember"),
    input: { content: "x" },
    effect: "require_approval",
    codes: ["risk_write"],
  },
  {
    name: "a team ask rule overrides the built-in remember allow",
    tool: builtin("remember"),
    input: { scope: "personal" },
    rules: [rule("team", "ask", "remember")],
    effect: "require_approval",
    codes: ["team_ask_rule"],
  },
  // Agent tools.allow / tools.deny (D19, §6.3 shorthand).
  {
    name: "agent tools.deny shorthand denies a matching bash command",
    tool: bash,
    input: { command: "rm -rf /workspace" },
    options: { toolsDeny: ["bash:rm -rf*"] },
    effect: "deny",
    codes: ["agent_tool_deny"],
  },
  {
    name: "agent tools.deny shorthand lets other commands through",
    tool: bash,
    input: { command: "ls" },
    options: { toolsDeny: ["bash:rm -rf*"] },
    effect: "allow",
    codes: ["risk_destructive"],
  },
  {
    name: "agent tools.allow restricts the agent's tools",
    tool: bash,
    options: { toolsAllow: ["read", "grep"] },
    effect: "deny",
    codes: ["agent_tool_deny"],
  },
  {
    name: "agent tools.allow never removes a prompt",
    tool: artifact,
    options: { toolsAllow: ["create_artifact"] },
    effect: "require_approval",
    codes: ["risk_write"],
  },
  {
    name: "agent deny shorthand on a tool without a primary argument denies the whole tool",
    tool: jiraCreate,
    options: { toolsDeny: ["mcp__jira__*:anything"] },
    effect: "deny",
    codes: ["agent_tool_deny"],
  },
  {
    name: "agent allow shorthand on a tool without a primary argument does not match",
    tool: jiraSearch,
    options: { toolsAllow: ["mcp__jira__*:anything"] },
    effect: "deny",
    codes: ["agent_tool_deny"],
  },
  {
    name: "malformed agent deny entry fails closed",
    tool: read,
    options: { toolsDeny: ["read\\"] },
    effect: "deny",
    codes: ["agent_tool_deny"],
  },
  // MCP exposure (D27).
  {
    name: "MCP tool of a connector not enabled in the team is denied",
    tool: jiraSearch,
    connector: { ...ENABLED_ALL, enabled: false },
    effect: "deny",
    codes: ["connector_not_enabled"],
  },
  {
    name: "drifted MCP tool is denied",
    tool: jiraSearch,
    connector: { ...ENABLED_ALL, drifted_tools: ["mcp__jira__search"] },
    effect: "deny",
    codes: ["tool_drifted"],
  },
  {
    name: "read-only exposure denies a write tool",
    tool: jiraCreate,
    options: { exposure: "read_only" },
    connector: { ...ENABLED_ALL, exposure: "read_only" },
    effect: "deny",
    codes: ["connector_exposure"],
  },
  {
    name: "read-only exposure allows a read tool",
    tool: jiraSearch,
    options: { exposure: "read_only" },
    connector: { ...ENABLED_ALL, exposure: "read_only" },
    effect: "allow",
    codes: ["risk_read"],
  },
  {
    name: "read-only claimed in the input wins over server state 'all'",
    tool: jiraCreate,
    options: { exposure: "read_only" },
    effect: "deny",
    codes: ["connector_exposure"],
  },
  {
    name: "server state read-only wins over 'all' claimed in the input",
    tool: jiraCreate,
    options: { exposure: "all" },
    connector: { ...ENABLED_ALL, exposure: "read_only" },
    effect: "deny",
    codes: ["connector_exposure"],
  },
  {
    name: "custom exposure allows an enabled tool (then prompts for its write)",
    tool: jiraCreate,
    options: { exposure: "custom" },
    connector: { ...ENABLED_ALL, exposure: "custom", enabled_tools: ["mcp__jira__create_issue"] },
    effect: "require_approval",
    codes: ["risk_write"],
  },
  {
    name: "custom exposure denies a tool not enabled",
    tool: jiraSearch,
    options: { exposure: "custom" },
    connector: { ...ENABLED_ALL, exposure: "custom", enabled_tools: ["mcp__jira__create_issue"] },
    effect: "deny",
    codes: ["connector_exposure"],
  },
  {
    name: "user allow cannot re-enable an unexposed MCP tool",
    tool: jiraCreate,
    options: { exposure: "read_only" },
    connector: { ...ENABLED_ALL, exposure: "read_only" },
    rules: [rule("user", "allow", "mcp__jira__*")],
    effect: "deny",
    codes: ["connector_exposure"],
  },
];

describe("evaluatePolicy: D29 order, table-driven", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const decision = run(c);
    expect(decision.effect).toBe(c.effect);
    expect(decision.reasons.map((r) => r.code)).toEqual(c.codes);
    expect(decision.risk).toBe(c.tool.risk);
  });

  it("reports the matching rule id, deterministically the lowest id", () => {
    const a = rule("team", "deny", "bash", { id: "00000000-0000-4000-8000-00000000000b" });
    const b = rule("team", "deny", "b*", { id: "00000000-0000-4000-8000-00000000000a" });
    const first = run({ tool: bash, rules: [a, b] });
    const second = run({ tool: bash, rules: [b, a] });
    expect(first).toEqual(second);
    expect(first.reasons.map((r) => r.rule_id)).toEqual([b.id, a.id]);
  });

  it("names the user rule that removed a prompt", () => {
    const allow = rule("user", "allow", "create_artifact");
    expect(run({ tool: artifact, rules: [allow] }).reasons[0]).toMatchObject({
      code: "user_allow_rule",
      stage: "user_allow",
      rule_id: allow.id,
    });
  });

  it("prefers the user's own allow rule over a team allow rule in the reason", () => {
    const team = rule("team", "allow", "create_artifact");
    const user = rule("user", "allow", "create_artifact");
    expect(run({ tool: artifact, rules: [team, user] }).reasons[0]?.rule_id).toBe(user.id);
  });

  it("sets a 1 h approval expiry on prompts", () => {
    const decision = run({ tool: artifact });
    expect(decision).toMatchObject({
      effect: "require_approval",
      expires_at: "2026-10-02T13:00:00.000Z",
    });
  });

  it("keeps the protocol's evaluation-order stages on every reason", () => {
    const decision = run({ tool: bash, rules: [rule("install", "deny", "bash")] });
    expect(decision.reasons[0]?.stage).toBe("install_deny");
  });
});

/** One scoped allow rule per known tool (blanket `*` allow rules are not allowed). */
function allowEverything(scope: "team" | "user"): PolicyRule[] {
  return [
    ...Object.keys(BUILTIN_TOOLS).map((name) => rule(scope, "allow", name)),
    rule(scope, "allow", "mcp__jira__*"),
    rule(scope, "allow", "mcp__fs__*"),
  ];
}

describe("evaluatePolicy: invariants over every combination", () => {
  const tools: ToolDescriptor[] = [
    ...Object.keys(BUILTIN_TOOLS).map((n) => builtin(n)),
    jiraCreate,
    jiraSearch,
    mcpTool("mcp__fs__delete", "destructive"),
  ];
  const ruleSets: PolicyRule[][] = [
    [],
    [rule("install", "ask", "*")],
    [rule("team", "ask", "*")],
    allowEverything("user"),
    [...allowEverything("team"), rule("team", "ask", "mcp__*")],
    [rule("install", "deny", "bash"), ...allowEverything("user")],
  ];
  const combos = APPROVAL_MODES.flatMap((mode) =>
    (["user", "schedule"] as const).flatMap((kind) =>
      [DEFAULT_POLICY_SETTINGS, PROMPT_SANDBOX].flatMap((settings) =>
        ruleSets.flatMap((rules) => tools.map((tool) => ({ mode, kind, settings, rules, tool }))),
      ),
    ),
  );

  it(`auto mode and scheduled runs never return require_approval (${combos.length} combinations)`, () => {
    for (const c of combos) {
      const decision = run({
        tool: c.tool,
        options: { mode: c.mode, kind: c.kind },
        rules: c.rules,
        settings: c.settings,
      });
      if (c.mode === "auto" || c.kind === "schedule") {
        expect(decision.effect, `${c.mode}/${c.kind}/${c.tool.name}`).not.toBe("require_approval");
      }
    }
  });

  it("an install deny always denies, whatever else applies", () => {
    for (const c of combos) {
      const decision = run({
        tool: c.tool,
        options: { mode: c.mode, kind: c.kind },
        rules: [...c.rules, rule("install", "deny", "*")],
        settings: c.settings,
      });
      expect(decision.effect).toBe("deny");
      expect(decision.reasons[0]?.code).toBe("install_deny_rule");
    }
  });

  it("an ask rule never yields allow, whatever allow rules exist", () => {
    for (const c of combos) {
      const decision = run({
        tool: c.tool,
        options: { mode: c.mode, kind: c.kind },
        rules: [...c.rules, rule("team", "ask", "*"), ...allowEverything("user")],
        settings: c.settings,
      });
      expect(decision.effect).not.toBe("allow");
    }
  });

  it("is deterministic: the same call decides the same way", () => {
    for (const c of combos.slice(0, 200)) {
      const args = {
        tool: c.tool,
        options: { mode: c.mode, kind: c.kind },
        rules: c.rules,
        settings: c.settings,
      };
      expect(run(args)).toEqual(run(args));
    }
  });

  it("decides fast: 1,000 rules × 1,000 calls in well under a second each batch", () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      rule(i % 2 === 0 ? "team" : "user", i % 2 === 0 ? "deny" : "allow", `mcp__svc${i}__*`, {
        arg_pattern: { "/a/b": `*${i}*` },
      }),
    );
    const start = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      run({ tool: jiraCreate, input: { a: { b: `value-${i}` } }, rules: many });
    }
    const perDecisionMs = (performance.now() - start) / 1000;
    expect(perDecisionMs).toBeLessThan(5);
  });
});
