import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { APPROVAL_KEY, MemoryApprovals, OTHER_KEY } from "../testing/approval-fixtures.js";
import {
  createSignedApprovalVerifier,
  DENY_UNVERIFIED_APPROVALS,
  type McpApprovalCall,
} from "./approvals.js";

const TOOL = "mcp__jira__create_issue";
const INPUT = { project: "OPS", title: "Disk full", labels: ["p1"] };

let approvals: MemoryApprovals;
let call: McpApprovalCall;
const verifier = () =>
  createSignedApprovalVerifier({
    tokens: approvals,
    store: approvals,
    keyFor: (kid) => (kid === APPROVAL_KEY.kid ? APPROVAL_KEY : undefined),
  });

beforeEach(() => {
  approvals = new MemoryApprovals();
  call = { teamId: randomUUID(), runId: randomUUID(), tool: TOOL, input: INPUT, now: new Date() };
  approvals.activeRuns.add(call.runId);
});

describe("DENY_UNVERIFIED_APPROVALS (until KOBE-37 is wired)", () => {
  it("authorises nothing, even with a valid signed approval in existence", async () => {
    approvals.allow(call);
    expect(await DENY_UNVERIFIED_APPROVALS.authorize(call)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("createSignedApprovalVerifier (Gate 2)", () => {
  it("authorises a call with a valid signed approval for exactly that call, once", async () => {
    const token = approvals.allow(call);
    expect(await verifier().authorize(call)).toEqual({ ok: true, approvalId: token.approval_id });
  });

  it("refuses an unsigned call (no approval exists)", async () => {
    expect(await verifier().authorize(call)).toEqual({ ok: false, reason: "no_approval" });
  });

  it("refuses a forged signature (MAC under another key)", async () => {
    approvals.allow({ ...call, key: OTHER_KEY });
    expect(await verifier().authorize(call)).toEqual({ ok: false, reason: "bad_mac" });
    expect(approvals.consumeCalls).toBe(0);
  });

  it("refuses a tampered MAC", async () => {
    const genuine = new MemoryApprovals().allow(call);
    const flipped = genuine.mac.endsWith("A") ? "B" : "A";
    approvals.add({ ...genuine, mac: `${genuine.mac.slice(0, 42)}${flipped}` });
    expect(await verifier().authorize(call)).toEqual({ ok: false, reason: "bad_mac" });
  });

  it("refuses a replayed approval (single use)", async () => {
    approvals.allow(call);
    expect((await verifier().authorize(call)).ok).toBe(true);
    expect(await verifier().authorize(call)).toEqual({ ok: false, reason: "not_consumable" });
  });

  it("refuses a changed input (the MAC covers the canonical input)", async () => {
    approvals.allow(call);
    const changed = { ...call, input: { ...INPUT, title: "Drop the database" } };
    expect(await verifier().authorize(changed)).toEqual({ ok: false, reason: "bad_mac" });
    // Key order is not a change: canonical JSON.
    const reordered = { ...call, input: { labels: ["p1"], title: "Disk full", project: "OPS" } };
    expect((await verifier().authorize(reordered)).ok).toBe(true);
  });

  it("refuses an expired approval", async () => {
    approvals.allow({ ...call, now: new Date(Date.now() - 11 * 60_000) });
    expect(await verifier().authorize(call)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses an approval for another tool, run or team", async () => {
    approvals.allow({ ...call, tool: "mcp__jira__get_issue" });
    approvals.allow({ ...call, runId: randomUUID() });
    expect(await verifier().authorize(call)).toEqual({ ok: false, reason: "no_approval" });
    const token = approvals.allow({ ...call, teamId: randomUUID() });
    approvals.add({ ...token, team_id: call.teamId });
    expect((await verifier().authorize(call)).ok).toBe(false);
  });

  it("binds the client's tool_call_id when one is given", async () => {
    approvals.allow({ ...call, toolCallId: "toolu_a" });
    expect(await verifier().authorize({ ...call, toolCallId: "toolu_b" })).toEqual({
      ok: false,
      reason: "no_approval",
    });
    expect((await verifier().authorize({ ...call, toolCallId: "toolu_a" })).ok).toBe(true);
  });

  it("refuses once the run has ended (Stop between approval and call)", async () => {
    approvals.allow(call);
    approvals.activeRuns.delete(call.runId);
    expect(await verifier().authorize(call)).toEqual({ ok: false, reason: "run_inactive" });
  });

  it("refuses a token whose key id is unknown", async () => {
    approvals.allow({ ...call, key: { kid: "old", secret: APPROVAL_KEY.secret } });
    expect(await verifier().authorize(call)).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("refuses when the approval row is not allowed (pending, denied, expired)", async () => {
    const token = approvals.allow({ ...call, teamId: call.teamId });
    const store = {
      load: () =>
        Promise.resolve({
          approval_id: token.approval_id,
          team_id: call.teamId,
          run_id: call.runId,
          tool_call_id: token.tool_call_id,
          status: "denied" as const,
          input_hmac: token.mac,
          run_active: true,
        }),
      consume: () => Promise.resolve(true),
    };
    const v = createSignedApprovalVerifier({
      tokens: approvals,
      store,
      keyFor: () => APPROVAL_KEY,
    });
    expect(await v.authorize(call)).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("fails closed when the token source throws", async () => {
    const errors: unknown[] = [];
    const v = createSignedApprovalVerifier({
      tokens: { candidates: () => Promise.reject(new Error("db down")) },
      store: approvals,
      keyFor: () => APPROVAL_KEY,
      onError: (e) => errors.push(e),
    });
    expect(await v.authorize(call)).toEqual({ ok: false, reason: "unavailable" });
    expect(errors).toHaveLength(1);
  });

  it("checks at most maxCandidates tokens", async () => {
    for (let i = 0; i < 5; i++) approvals.allow({ ...call, key: OTHER_KEY });
    approvals.allow({ ...call, now: new Date(Date.now() - 60 * 60_000) });
    const v = createSignedApprovalVerifier({
      tokens: approvals,
      store: approvals,
      keyFor: () => APPROVAL_KEY,
      maxCandidates: 2,
    });
    expect((await v.authorize(call)).ok).toBe(false);
  });
});
