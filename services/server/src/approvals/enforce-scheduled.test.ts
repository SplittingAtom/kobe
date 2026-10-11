import { describe, expect, it } from "vitest";
import type { PolicyDecision, PolicyInput } from "@kobe/protocol";
import { enforceMcpCall, type ApprovalVerifier } from "./verify.js";

const ask: PolicyDecision = {
  effect: "require_approval",
  risk: "write",
  reasons: [{ code: "team_ask_rule", stage: "ask_rule", message: "asked" }],
  expires_at: "2026-10-10T00:00:00.000Z",
};

function input(kind: "user" | "schedule"): PolicyInput {
  return {
    actor: { user_id: "u", kind },
    team_id: "t",
    run: { run_id: "r", approval_mode: "ask-on-write" },
    tool: { name: "mcp__x__y", risk: "write" },
    tool_call_id: "c",
    input: {},
  } as unknown as PolicyInput;
}

describe("enforceMcpCall and scheduled runs (D32)", () => {
  it("never consults the verifier for a scheduled run, even when the engine asks", async () => {
    let verified = 0;
    const verifier: ApprovalVerifier = {
      authorize: () => {
        verified += 1;
        return Promise.resolve({ ok: true, approvalId: "a" });
      },
    };
    const out = await enforceMcpCall(
      { decide: () => Promise.resolve(ask) },
      verifier,
      input("schedule"),
    );
    expect(out.decision).toBe("deny");
    expect(verified).toBe(0);
  });

  it("still verifies the signed approval for an interactive run", async () => {
    let verified = 0;
    const verifier: ApprovalVerifier = {
      authorize: () => {
        verified += 1;
        return Promise.resolve({ ok: true, approvalId: "a" });
      },
    };
    const out = await enforceMcpCall(
      { decide: () => Promise.resolve(ask) },
      verifier,
      input("user"),
    );
    expect(out.decision).toBe("allow");
    expect(verified).toBe(1);
  });
});
