import { describe, expect, it } from "vitest";
import { approvalSigningString } from "@kobe/protocol";
import { computeApprovalMac, signApproval, verifyApproval } from "@kobe/protocol/node";
import { approvalKeyFromSecret, approvalKeyring } from "./keys.js";

/**
 * The approval signature as KOBE-37 uses it (docs/approvals.md "Signing"): a known-answer vector
 * any other implementation (KOBE-58's MCP proxy) can check itself against, and the tampering
 * cases the ticket names. The protocol's own tests cover the primitives.
 */

const BINDING = {
  team_id: "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e",
  run_id: "7f000000-0000-4000-8000-000000000001",
  tool_call_id: "toolu_01",
  tool: "mcp__jira__create_issue",
  expires_at: "2026-10-03T12:10:00.000Z",
};
const INPUT = {
  summary: "Résumé ✓",
  project: "OPS",
  priority: 2.5,
  labels: ["a", "b"],
  nested: { z: null, a: true },
};

describe("approval signing (known answer)", () => {
  it("signs the canonical tuple [domain, team, run, call, tool, expires_at, input]", () => {
    expect(approvalSigningString(BINDING, INPUT)).toBe(
      '["kobe.approval.v1","0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e",' +
        '"7f000000-0000-4000-8000-000000000001","toolu_01","mcp__jira__create_issue",' +
        '"2026-10-03T12:10:00.000Z",{"labels":["a","b"],"nested":{"a":true,"z":null},' +
        '"priority":2.5,"project":"OPS","summary":"Résumé ✓"}]',
    );
    expect(computeApprovalMac(new TextEncoder().encode("k".repeat(32)), BINDING, INPUT)).toBe(
      "AUmjIxGbUR8GQt_ET-sAD0R3Yvu0rdQsdeB7CvwhPKM",
    );
  });

  it("is the same for the same input written differently (key order, number spelling)", () => {
    const rewritten = JSON.parse(
      '{"nested":{"a":true,"z":null},"labels":["a","b"],"priority":2.50,' +
        '"project":"OPS","summary":"R\\u00e9sum\\u00e9 \\u2713"}',
    ) as unknown;
    expect(approvalSigningString(BINDING, rewritten)).toBe(approvalSigningString(BINDING, INPUT));
  });
});

describe("tampering", () => {
  const key = approvalKeyFromSecret("s".repeat(40));
  const now = new Date("2026-10-03T12:00:00.000Z");
  const token = signApproval({
    key,
    approval_id: "9a000000-0000-4000-8000-000000000009",
    ...BINDING,
    input: INPUT,
    now,
  });
  const verify = (over: {
    input?: unknown;
    run_id?: string;
    tool_call_id?: string;
    tool?: string;
    at?: Date;
    keyFor?: (kid: string) => typeof key | undefined;
  }) =>
    verifyApproval({
      token,
      expected: {
        team_id: BINDING.team_id,
        run_id: over.run_id ?? BINDING.run_id,
        tool_call_id: over.tool_call_id ?? BINDING.tool_call_id,
        tool: over.tool ?? BINDING.tool,
      },
      input: over.input ?? INPUT,
      now: over.at ?? new Date(now.getTime() + 60_000),
      keyFor: over.keyFor ?? ((kid) => (kid === key.kid ? key : undefined)),
    });

  it("verifies the approved call", () => {
    expect(verify({}).ok).toBe(true);
  });

  it.each([
    ["a changed value", { input: { ...INPUT, project: "OPS2" } }, "bad_mac"],
    ["an added argument", { input: { ...INPUT, assignee: "me" } }, "bad_mac"],
    [
      "an NFD spelling",
      { input: { ...INPUT, summary: INPUT.summary.normalize("NFD") } },
      "bad_mac",
    ],
    ["a 2.5 → 2.6 number", { input: { ...INPUT, priority: 2.6 } }, "bad_mac"],
    ["a replayed tool_call_id", { tool_call_id: "toolu_02" }, "binding_mismatch"],
    ["a different run", { run_id: "7f000000-0000-4000-8000-000000000002" }, "binding_mismatch"],
    ["another tool", { tool: "mcp__jira__delete_issue" }, "binding_mismatch"],
    ["an expired token", { at: new Date(now.getTime() + 10 * 60_000) }, "expired"],
    ["a rotated key", { keyFor: () => undefined }, "unknown_key"],
  ] as const)("refuses %s", (_label, over, reason) => {
    expect(verify(over)).toEqual({ ok: false, reason });
  });
});

describe("approval keys", () => {
  it("derives a stable kid from the key and refuses short keys", () => {
    const a = approvalKeyring("x".repeat(48));
    expect(a.current.kid).toMatch(/^a-[0-9a-f]{12}$/);
    expect(approvalKeyring("x".repeat(48)).current.kid).toBe(a.current.kid);
    expect(approvalKeyring("y".repeat(48)).current.kid).not.toBe(a.current.kid);
    expect(a.keyFor(a.current.kid)).toBe(a.current);
    expect(a.keyFor("a-000000000000")).toBeUndefined();
    expect(() => approvalKeyFromSecret("short")).toThrow(/at least 32/);
  });
});
