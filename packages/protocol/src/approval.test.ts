import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_SIGNING_DOMAIN,
  approvalSigningBytes,
  approvalSigningString,
  approvalTokenSchema,
  type ApprovalBinding,
  type ApprovalRecord,
  type ApprovalStore,
} from "./index.js";
import {
  authorizeApprovedCall,
  computeApprovalMac,
  signApproval,
  verifyApproval,
  type ApprovalKey,
  type VerifyApprovalInput,
} from "./node/index.js";
import { EXAMPLE_IDS } from "./testing/index.js";

/** Test key: bytes 0x00..0x1f. Golden MACs below were computed independently (Python hmac). */
const KEY: ApprovalKey = { kid: "test", secret: Uint8Array.from({ length: 32 }, (_, i) => i) };
const keyFor = (kid: string) => (kid === KEY.kid ? KEY : undefined);

const TEAM = EXAMPLE_IDS.team;
const RUN = EXAMPLE_IDS.run;
const CREATE = "mcp__jira__create_issue";
const DELETE = "mcp__jira__delete_issue";
const DECIDED_AT = new Date("2026-10-01T22:15:00.000Z");
const EXPIRES_AT = "2026-10-01T22:25:00.000Z";
const INPUT = { summary: "Disk full ✓", project: "OPS", n: [1, 2.5, -0] };
const binding = (tool: string): ApprovalBinding => ({
  team_id: TEAM,
  run_id: RUN,
  tool_call_id: "tc_9",
  tool,
  expires_at: EXPIRES_AT,
});

describe("approval signing bytes", () => {
  it("is canonical JSON of [domain, team, run, call, tool, expires_at, input]", () => {
    expect(APPROVAL_SIGNING_DOMAIN).toBe("kobe.approval.v1");
    const expected = `["kobe.approval.v1","${TEAM}","${RUN}","tc_9","${CREATE}","${EXPIRES_AT}",{"n":[1,2.5,0],"project":"OPS","summary":"Disk full ✓"}]`;
    expect(approvalSigningString(binding(CREATE), INPUT)).toBe(expected);
    expect(Buffer.from(approvalSigningBytes(binding(CREATE), INPUT))).toEqual(
      Buffer.from(expected, "utf8"),
    );
  });

  it("cannot be confused by delimiter games between fields", () => {
    const a = { ...binding(CREATE), run_id: "a,b", tool_call_id: "c" };
    const b = { ...binding(CREATE), run_id: "a", tool_call_id: "b,c" };
    expect(approvalSigningString(a, {})).not.toBe(approvalSigningString(b, {}));
  });
});

describe("approval HMAC golden vectors", () => {
  it.each([
    ["create_issue", CREATE, INPUT, "qbWYpNoF2pEa4o3Xx7zSNtttC4MrsCzeOkAPq2gKO0w"],
    ["same input, other tool", DELETE, INPUT, "fsNUCukuSmSX8alpK4R_SWA-FYcAAfiXh46plF0AxaY"],
    ["NFC path", "write", { path: "café.txt" }, "nL7vWhlRsmLwDt9vP8zbeIbDJk6kIf9iltNJyTme5Lc"],
    ["NFD path", "write", { path: "café.txt" }, "0QFWZkq-nkaQQYHAra2WsPvFRUCjK2IH0ULN2fdiyD8"],
  ])("%s", (_label, tool, input, mac) => {
    expect(computeApprovalMac(KEY.secret, binding(tool), input)).toBe(mac);
  });

  it("agrees with a direct HMAC over the signing bytes", () => {
    const direct = createHmac("sha256", KEY.secret)
      .update(approvalSigningBytes(binding("t"), { x: 1 }))
      .digest("base64url");
    expect(computeApprovalMac(KEY.secret, binding("t"), { x: 1 })).toBe(direct);
  });
});

const token = signApproval({
  key: KEY,
  approval_id: EXAMPLE_IDS.approval,
  team_id: TEAM,
  run_id: RUN,
  tool_call_id: "tc_9",
  tool: CREATE,
  input: INPUT,
  now: DECIDED_AT,
});
const base: VerifyApprovalInput = {
  token,
  expected: { team_id: TEAM, run_id: RUN, tool_call_id: "tc_9", tool: CREATE },
  input: INPUT,
  now: new Date("2026-10-01T22:16:00.000Z"),
  keyFor,
};
const verify = (overrides: Partial<VerifyApprovalInput>) =>
  verifyApproval({ ...base, ...overrides });

describe("verifyApproval (stateless half)", () => {
  it("produces a schema-valid token expiring APPROVAL_TOKEN_TTL_MS after the decision", () => {
    expect(approvalTokenSchema.parse(token)).toEqual(token);
    expect(token).toMatchObject({
      v: 1,
      alg: "HS256",
      kid: "test",
      team_id: TEAM,
      tool: CREATE,
      expires_at: EXPIRES_AT,
      mac: "qbWYpNoF2pEa4o3Xx7zSNtttC4MrsCzeOkAPq2gKO0w",
    });
  });

  it("verifies the same input with keys in any order", () => {
    const reordered = { n: [1, 2.5, 0], project: "OPS", summary: "Disk full ✓" };
    expect(verify({ input: reordered }).ok).toBe(true);
  });

  it("rejects a changed input", () => {
    expect(verify({ input: { ...INPUT, project: "PROD" } })).toEqual({
      ok: false,
      reason: "bad_mac",
    });
    expect(verify({ input: { ...INPUT, extra: true } })).toEqual({ ok: false, reason: "bad_mac" });
  });

  it("does not let a get/create approval authorise another tool with the same ids", () => {
    const expected = { ...base.expected, tool: DELETE };
    expect(verify({ expected })).toEqual({ ok: false, reason: "binding_mismatch" });
    expect(verify({ expected, token: { ...token, tool: DELETE } })).toEqual({
      ok: false,
      reason: "bad_mac",
    });
  });

  it("rejects tokens bound to another team, run or call, edited or not", () => {
    const other = { ...base.expected, team_id: EXAMPLE_IDS.otherTeam };
    expect(verify({ expected: other })).toEqual({ ok: false, reason: "binding_mismatch" });
    expect(
      verify({ expected: other, token: { ...token, team_id: EXAMPLE_IDS.otherTeam } }),
    ).toEqual({ ok: false, reason: "bad_mac" });
    expect(verify({ expected: { ...base.expected, tool_call_id: "tc_10" } })).toEqual({
      ok: false,
      reason: "binding_mismatch",
    });
  });

  it("expires, and an extended expiry does not verify", () => {
    expect(verify({ now: new Date("2026-10-01T22:24:59.999Z") }).ok).toBe(true);
    expect(verify({ now: new Date(EXPIRES_AT) })).toEqual({ ok: false, reason: "expired" });
    const extended = { ...token, expires_at: "2026-10-02T22:25:00.000Z" };
    expect(verify({ token: extended, now: new Date(EXPIRES_AT) })).toEqual({
      ok: false,
      reason: "bad_mac",
    });
  });

  it("rejects unknown keys, malformed tokens and uncanonicalisable input", () => {
    expect(verify({ keyFor: () => undefined })).toEqual({ ok: false, reason: "unknown_key" });
    expect(verify({ token: { ...token, mac: "short" } })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verify({ token: { ...token, v: 2 } })).toEqual({ ok: false, reason: "malformed" });
    expect(verify({ token: { ...token, expires_at: "2026-10-01T22:25:00Z" } })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verify({ token: null })).toEqual({ ok: false, reason: "malformed" });
    expect(verify({ input: { x: Number.NaN } })).toEqual({ ok: false, reason: "malformed" });
    expect(verify({ input: { id: 2 ** 53 } })).toEqual({ ok: false, reason: "malformed" });
    expect(verify({ input: [1] })).toEqual({ ok: false, reason: "malformed" });
    expect(verify({ input: JSON.parse('{"__proto__":{"a":1}}') })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses short keys", () => {
    const short: ApprovalKey = { kid: "short", secret: new Uint8Array(16) };
    expect(() =>
      signApproval({ ...base, ...token, key: short, input: {}, now: DECIDED_AT }),
    ).toThrow(/shorter than 32 bytes/);
  });
});

function fakeStore(record: Partial<ApprovalRecord> | undefined) {
  let consumed = 0;
  const store: ApprovalStore = {
    load: (teamId, approvalId) =>
      Promise.resolve(
        record === undefined
          ? undefined
          : {
              approval_id: approvalId,
              team_id: teamId,
              run_id: RUN,
              tool_call_id: "tc_9",
              status: "allowed",
              input_hmac: token.mac,
              run_active: true,
              ...record,
            },
      ),
    consume: () => Promise.resolve(++consumed === 1),
  };
  return { store, consumed: () => consumed };
}

describe("authorizeApprovedCall (stateful half)", () => {
  it("allows exactly once", async () => {
    const { store } = fakeStore({});
    expect((await authorizeApprovedCall({ ...base, store })).ok).toBe(true);
    expect(await authorizeApprovedCall({ ...base, store })).toEqual({
      ok: false,
      reason: "not_consumable",
    });
  });

  it.each([
    ["missing row", undefined, "not_allowed"],
    ["pending", { status: "pending" }, "not_allowed"],
    ["denied", { status: "denied" }, "not_allowed"],
    ["expired", { status: "expired" }, "not_allowed"],
    ["row for another call", { tool_call_id: "tc_10" }, "record_mismatch"],
    ["row with another hmac", { input_hmac: "x".repeat(43) }, "record_mismatch"],
    ["row without hmac", { input_hmac: null }, "record_mismatch"],
    ["run ended", { run_active: false }, "run_inactive"],
  ] as const)("rejects %s without consuming", async (_label, record, reason) => {
    const { store, consumed } = fakeStore(record);
    expect(await authorizeApprovedCall({ ...base, store })).toEqual({ ok: false, reason });
    expect(consumed()).toBe(0);
  });

  it("does not touch state when the stateless half fails", async () => {
    const { store, consumed } = fakeStore({});
    const result = await authorizeApprovedCall({ ...base, store, input: { other: 1 } });
    expect(result).toEqual({ ok: false, reason: "bad_mac" });
    expect(consumed()).toBe(0);
  });
});
