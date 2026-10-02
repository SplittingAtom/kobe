import { describe, expect, it } from "vitest";
import {
  POLICY_EVALUATION_ORDER,
  approvalResolutionBodySchema,
  isOpenWorld,
  policyDecisionSchema,
  policyInputSchema,
  riskFromAnnotations,
  type PolicyInput,
} from "./index.js";
import { createFakePolicyEngine } from "./testing/index.js";

const input: PolicyInput = policyInputSchema.parse({
  actor: { user_id: "u1", kind: "user" },
  team_id: "t1",
  agent: { agent_id: "a1", version: 2 },
  run: { run_id: "r1", thread_id: "th1", approval_mode: "ask-on-write" },
  tool: { name: "mcp__jira__create_issue", source: "mcp", connector_id: "c1" },
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

  it("fills defaults on input", () => {
    expect(input.tool.annotations).toEqual({});
    expect(input.agent.tools_allow).toEqual([]);
  });

  it.each([
    ["bypass approval mode", { ...input, run: { ...input.run, approval_mode: "bypass" } }],
    ["non-object input", { ...input, input: [1] }],
    ["unknown enforcement point", { ...input, context: { enforcement_point: "browser" } }],
    ["missing tool_call_id", { ...input, tool_call_id: undefined }],
  ])("rejects input with %s", (_label, value) => {
    expect(policyInputSchema.safeParse(value).success).toBe(false);
  });

  it("validates decisions", () => {
    const reasons = [{ code: "risk_write", stage: "risk_class", message: "write" }];
    expect(policyDecisionSchema.safeParse({ effect: "allow", risk: "read", reasons }).success).toBe(
      true,
    );
    expect(
      policyDecisionSchema.safeParse({
        effect: "require_approval",
        risk: "write",
        reasons,
        expires_at: "2026-10-01T23:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      policyDecisionSchema.safeParse({ effect: "require_approval", risk: "write", reasons })
        .success,
    ).toBe(false);
    expect(
      policyDecisionSchema.safeParse({ effect: "allow", risk: "read", reasons: [] }).success,
    ).toBe(false);
    expect(
      policyDecisionSchema.safeParse({ effect: "bypass", risk: "read", reasons }).success,
    ).toBe(false);
  });

  it.each([
    [{}, "destructive", true],
    [{ readOnlyHint: true }, "read", true],
    [{ readOnlyHint: false, destructiveHint: false }, "write", true],
    [{ destructiveHint: true, openWorldHint: false }, "destructive", false],
    [{ readOnlyHint: true, destructiveHint: true }, "read", true],
  ] as const)("derives risk from annotations %j", (annotations, risk, openWorld) => {
    expect(riskFromAnnotations(annotations)).toBe(risk);
    expect(isOpenWorld(annotations)).toBe(openWorld);
  });

  it("validates POST /v1/approvals/{id}", () => {
    expect(approvalResolutionBodySchema.safeParse({ decision: "allow" }).success).toBe(true);
    expect(
      approvalResolutionBodySchema.safeParse({
        decision: "allow",
        remember: { tool_glob: "mcp__jira__*", expires_in: 3600 },
      }).success,
    ).toBe(true);
    expect(approvalResolutionBodySchema.safeParse({ decision: "approve" }).success).toBe(false);
    expect(
      approvalResolutionBodySchema.safeParse({ decision: "allow", remember: { expires_in: -1 } })
        .success,
    ).toBe(false);
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
