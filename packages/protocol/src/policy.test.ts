import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOLS,
  POLICY_EVALUATION_ORDER,
  acceptsAudience,
  approvalResolutionBodySchema,
  builtinToolDescriptor,
  isOpenWorld,
  policyDecisionSchema,
  policyInputSchema,
  riskFromAnnotations,
  sessionTokenClaimsSchema,
  toolRuleSchema,
  type PolicyInput,
  type SessionTokenClaims,
} from "./index.js";
import { EXAMPLE_IDS, createFakePolicyEngine } from "./testing/index.js";

const input: PolicyInput = policyInputSchema.parse({
  actor: { user_id: EXAMPLE_IDS.user, kind: "user" },
  team_id: EXAMPLE_IDS.team,
  agent: { agent_id: EXAMPLE_IDS.agent, version: 2 },
  run: { run_id: EXAMPLE_IDS.run, thread_id: EXAMPLE_IDS.thread, approval_mode: "ask-on-write" },
  tool: {
    name: "mcp__jira__create_issue",
    source: "mcp",
    connector_id: EXAMPLE_IDS.connector,
    risk: "write",
    open_world: true,
    scope: "external",
  },
  tool_call_id: "tc_9",
  input: { project: "OPS" },
  context: { enforcement_point: "sandbox", connector_exposure: "all" },
});

describe("policy contract", () => {
  it("follows the D29 evaluation order", () => {
    expect(POLICY_EVALUATION_ORDER).toEqual([
      "install_deny",
      "team_deny",
      "ask_rule",
      "risk_class",
      "approval_mode",
      "user_allow",
      "prompt",
    ]);
  });

  it("fills defaults and accepts the install default agent", () => {
    expect(input.agent.tools_allow).toEqual([]);
    const defaultAgent = { ...input, agent: { ...input.agent, agent_id: null, version: null } };
    expect(policyInputSchema.safeParse(defaultAgent).success).toBe(true);
  });

  it.each([
    ["bypass approval mode", { ...input, run: { ...input.run, approval_mode: "bypass" } }],
    ["non-object input", { ...input, input: [1] }],
    ["unsafe integer input", { ...input, input: { id: 2 ** 53 } }],
    ["U+0000 in input", { ...input, input: { s: "a\u0000" } }],
    ["__proto__ in input", { ...input, input: JSON.parse('{"a":{"__proto__":{"x":1}}}') }],
    ["unknown enforcement point", { ...input, context: { enforcement_point: "browser" } }],
    ["missing tool_call_id", { ...input, tool_call_id: undefined }],
    ["non-uuid team", { ...input, team_id: "t1" }],
    [
      "sandbox-style annotations on the tool",
      { ...input, tool: { ...input.tool, annotations: {} } },
    ],
  ])("rejects input with %s", (_label, value) => {
    expect(policyInputSchema.safeParse(value).success).toBe(false);
  });

  it("validates decisions", () => {
    const reasons = [{ code: "risk_write", stage: "risk_class", message: "write" }];
    const ok = (v: unknown) => policyDecisionSchema.safeParse(v).success;
    expect(ok({ effect: "allow", risk: "read", reasons })).toBe(true);
    expect(
      ok({
        effect: "require_approval",
        risk: "write",
        reasons,
        expires_at: "2026-10-01T23:00:00Z",
      }),
    ).toBe(true);
    expect(ok({ effect: "require_approval", risk: "write", reasons })).toBe(false);
    expect(ok({ effect: "allow", risk: "read", reasons: [] })).toBe(false);
    expect(ok({ effect: "bypass", risk: "read", reasons })).toBe(false);
  });

  it("validates POST /v1/approvals/{id} with structured arg patterns", () => {
    const ok = (v: unknown) => approvalResolutionBodySchema.safeParse(v).success;
    expect(ok({ decision: "allow" })).toBe(true);
    expect(
      ok({ decision: "allow", remember: { tool_glob: "mcp__jira__*", expires_in: 3600 } }),
    ).toBe(true);
    expect(
      ok({
        decision: "allow",
        remember: { tool_glob: "bash", arg_pattern: { "/command": "git status*" } },
      }),
    ).toBe(true);
    expect(ok({ decision: "allow", remember: { tool_glob: "bash", arg_pattern: "^git.*$" } })).toBe(
      false,
    );
    expect(ok({ decision: "allow", remember: { tool_glob: "bash", arg_pattern: {} } })).toBe(false);
    expect(
      ok({ decision: "allow", remember: { tool_glob: "bash", arg_pattern: { command: "x" } } }),
    ).toBe(false);
    expect(ok({ decision: "approve" })).toBe(false);
    expect(ok({ decision: "allow", remember: { tool_glob: "x", expires_in: -1 } })).toBe(false);
    expect(ok({ decision: "allow", remember: { tool_glob: "trailing\\" } })).toBe(false);
  });

  it("validates tool rules", () => {
    const rule = {
      id: EXAMPLE_IDS.approval,
      scope: "team",
      scope_ref: EXAMPLE_IDS.team,
      effect: "deny",
      tool_glob: "bash",
    };
    expect(toolRuleSchema.safeParse(rule).success).toBe(true);
    expect(toolRuleSchema.safeParse({ ...rule, effect: "bypass" }).success).toBe(false);
  });
});

describe("server-side tool registry", () => {
  it("covers the Pi 1.0.0 built-ins and kobe-tools", () => {
    expect(Object.keys(BUILTIN_TOOLS).sort()).toEqual(
      [
        "bash",
        "codemode",
        "create_artifact",
        "edit",
        "find",
        "grep",
        "list_mcp_resource_templates",
        "list_mcp_resources",
        "ls",
        "powershell",
        "read",
        "read_mcp_resource",
        "recall",
        "remember",
        "share_file",
        "tool_search",
        "update_artifact",
        "write",
      ].sort(),
    );
  });

  it("resolves built-ins and treats everything else as unknown", () => {
    expect(builtinToolDescriptor("bash")).toEqual({
      name: "bash",
      source: "pi",
      risk: "destructive",
      open_world: true,
      scope: "sandbox",
    });
    expect(builtinToolDescriptor("read")?.risk).toBe("read");
    expect(builtinToolDescriptor("mcp__jira__create_issue")).toBeUndefined();
    expect(builtinToolDescriptor("toString")).toBeUndefined();
    expect(builtinToolDescriptor("__proto__")).toBeUndefined();
  });

  it.each([
    [{}, "destructive", true],
    [{ readOnlyHint: true }, "read", true],
    [{ readOnlyHint: false, destructiveHint: false }, "write", true],
    [{ destructiveHint: true, openWorldHint: false }, "destructive", false],
    [{ readOnlyHint: true, destructiveHint: true }, "read", true],
  ] as const)("derives MCP risk from pinned annotations %j", (annotations, risk, openWorld) => {
    expect(riskFromAnnotations(annotations)).toBe(risk);
    expect(isOpenWorld(annotations)).toBe(openWorld);
  });
});

describe("session token audience binding", () => {
  const claims: SessionTokenClaims = {
    iss: "kobe-server",
    aud: "kobe.mcp-proxy",
    sub: EXAMPLE_IDS.sandbox,
    team_id: EXAMPLE_IDS.team,
    user_id: EXAMPLE_IDS.user,
    iat: 1_000,
    exp: 2_000,
    jti: "0123456789abcdef",
  };

  it("accepts only its own audience, unexpired", () => {
    expect(sessionTokenClaimsSchema.parse(claims)).toEqual(claims);
    expect(acceptsAudience(claims, "kobe.mcp-proxy", 1_500)).toBe(true);
    expect(acceptsAudience(claims, "kobe.sandbox-wire", 1_500)).toBe(false);
    expect(acceptsAudience(claims, "kobe.mcp-proxy", 2_000)).toBe(false);
    expect(sessionTokenClaimsSchema.safeParse({ ...claims, aud: "*" }).success).toBe(false);
  });
});

describe("fake policy engine", () => {
  it("returns configured effects and fails closed for unknown tools", async () => {
    const engine = createFakePolicyEngine({ mcp__jira__create_issue: "require_approval" });
    expect((await engine.decide(input)).effect).toBe("require_approval");
    expect((await engine.decide({ ...input, tool: { ...input.tool, name: "bash" } })).effect).toBe(
      "deny",
    );
    expect(engine.calls).toHaveLength(2);
  });

  it("never asks in auto mode or for scheduled runs (D32 deny-don't-wait)", async () => {
    const engine = createFakePolicyEngine({ mcp__jira__create_issue: "require_approval" });
    const auto = await engine.decide({ ...input, run: { ...input.run, approval_mode: "auto" } });
    const scheduled = await engine.decide({
      ...input,
      actor: { ...input.actor, kind: "schedule" },
    });
    expect([auto.effect, scheduled.effect]).toEqual(["deny", "deny"]);
    expect(policyDecisionSchema.parse(auto)).toEqual(auto);
  });
});
