import type { PolicyDecision, PolicyEngine, PolicyInput } from "../policy.js";
import { APPROVAL_TTL_MS } from "../approval.js";

/**
 * Fake policy engine for tests of consumers (kobe-policy, MCP proxy, approvals, schedules).
 * Decisions come from a map keyed by tool name; anything else is denied (fail closed). It keeps
 * the contract invariant: in `auto` mode or for scheduled runs `require_approval` becomes `deny`.
 */
export type FakeEffect = PolicyDecision["effect"];

export interface FakePolicyEngine extends PolicyEngine {
  readonly calls: readonly PolicyInput[];
}

export function createFakePolicyEngine(
  effects: Readonly<Record<string, FakeEffect>>,
  now: () => Date = () => new Date(),
): FakePolicyEngine {
  let calls: readonly PolicyInput[] = [];

  return {
    get calls() {
      return calls;
    },
    decide(input) {
      calls = [...calls, input];
      const risk = input.tool.risk;
      const effect = effects[input.tool.name] ?? "deny";
      const noPrompt = input.run.approval_mode === "auto" || input.actor.kind === "schedule";
      if (effect === "allow") {
        return Promise.resolve({
          effect,
          risk,
          reasons: [{ code: "user_allow_rule", stage: "user_allow", message: "allowed (fake)" }],
        });
      }
      if (effect === "require_approval" && !noPrompt) {
        return Promise.resolve({
          effect,
          risk,
          reasons: [{ code: "default_prompt", stage: "prompt", message: "needs approval (fake)" }],
          expires_at: new Date(now().getTime() + APPROVAL_TTL_MS).toISOString(),
        });
      }
      const code = effect === "require_approval" ? "mode_auto_not_allowlisted" : "team_deny_rule";
      const stage = effect === "require_approval" ? "approval_mode" : "team_deny";
      return Promise.resolve({
        effect: "deny",
        risk,
        reasons: [{ code, stage, message: "denied (fake)" }],
      });
    },
  };
}
