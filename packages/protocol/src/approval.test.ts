import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_SIGNING_DOMAIN,
  approvalSigningBytes,
  approvalSigningString,
  approvalTokenSchema,
} from "./index.js";
import {
  computeApprovalMac,
  signApproval,
  verifyApproval,
  type ApprovalKey,
} from "./node/index.js";

/** Test key: bytes 0x00..0x1f. Golden MACs below were computed independently (Python hmac). */
const KEY: ApprovalKey = { kid: "test", secret: Uint8Array.from({ length: 32 }, (_, i) => i) };
const keyFor = (kid: string) => (kid === KEY.kid ? KEY : undefined);

const INPUT = { summary: "Disk full ✓", project: "OPS", n: [1, 2.5, -0] };

describe("approval signing bytes", () => {
  it("is canonical JSON of [domain, run_id, tool_call_id, input]", () => {
    expect(APPROVAL_SIGNING_DOMAIN).toBe("kobe.approval.v1");
    expect(approvalSigningString("run_7f", "tc_9", INPUT)).toBe(
      '["kobe.approval.v1","run_7f","tc_9",{"n":[1,2.5,0],"project":"OPS","summary":"Disk full ✓"}]',
    );
    expect(Buffer.from(approvalSigningBytes("run_7f", "tc_9", INPUT)).toString("hex")).toBe(
      Buffer.from(
        '["kobe.approval.v1","run_7f","tc_9",{"n":[1,2.5,0],"project":"OPS","summary":"Disk full ✓"}]',
        "utf8",
      ).toString("hex"),
    );
  });

  it("cannot be confused by delimiter games between ids", () => {
    expect(approvalSigningString("a,b", "c", {})).not.toBe(approvalSigningString("a", "b,c", {}));
    expect(approvalSigningString('a"', "b", {})).not.toBe(approvalSigningString("a", '"b', {}));
  });
});

describe("approval HMAC golden vectors", () => {
  it.each([
    ["mixed input", INPUT, "EeUcBxYfh-SRKr2AObnPe6oYfXEpKLxZMlgtpnuLOiU"],
    ["NFC path", { path: "caf\u00e9.txt" }, "wvNLHcLg9Ctfo9du4gHkIq5Fky8aM73Rjg8LEoUawUk"],
    ["NFD path", { path: "cafe\u0301.txt" }, "WXj53jHsDEdfVwLcMuuLJNWSK-dqxuSTWeI9244JUWU"],
  ])("%s", (_label, input, mac) => {
    expect(computeApprovalMac(KEY.secret, "run_7f", "tc_9", input)).toBe(mac);
  });

  it("agrees with a direct HMAC over the signing bytes", () => {
    const direct = createHmac("sha256", KEY.secret)
      .update(approvalSigningBytes("r", "t", { x: 1 }))
      .digest("base64url");
    expect(computeApprovalMac(KEY.secret, "r", "t", { x: 1 })).toBe(direct);
  });
});

describe("signApproval / verifyApproval", () => {
  const token = signApproval({
    key: KEY,
    approval_id: "apr_31",
    run_id: "run_7f",
    tool_call_id: "tc_9",
    input: INPUT,
  });
  const verify = (overrides: Partial<Parameters<typeof verifyApproval>[0]>) =>
    verifyApproval({
      token,
      run_id: "run_7f",
      tool_call_id: "tc_9",
      input: INPUT,
      keyFor,
      ...overrides,
    });

  it("produces a schema-valid token", () => {
    expect(approvalTokenSchema.parse(token)).toEqual(token);
    expect(token).toMatchObject({
      v: 1,
      alg: "HS256",
      kid: "test",
      mac: "EeUcBxYfh-SRKr2AObnPe6oYfXEpKLxZMlgtpnuLOiU",
    });
  });

  it("verifies the same input with keys in any order", () => {
    expect(
      verify({ input: { n: [1, 2.5, 0], project: "OPS", summary: "Disk full \u2713" } }).ok,
    ).toBe(true);
  });

  it("rejects a changed input", () => {
    expect(verify({ input: { ...INPUT, project: "PROD" } })).toEqual({
      ok: false,
      reason: "bad_mac",
    });
    expect(verify({ input: { ...INPUT, extra: true } })).toEqual({ ok: false, reason: "bad_mac" });
  });

  it("rejects a token for another run or call", () => {
    expect(verify({ run_id: "run_other" })).toEqual({ ok: false, reason: "binding_mismatch" });
    expect(verify({ tool_call_id: "tc_10" })).toEqual({ ok: false, reason: "binding_mismatch" });
  });

  it("rejects a token whose ids were edited to match another call", () => {
    const forged = { ...token, tool_call_id: "tc_10" };
    expect(verify({ token: forged, tool_call_id: "tc_10" })).toEqual({
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
    expect(verify({ token: null })).toEqual({ ok: false, reason: "malformed" });
    expect(verify({ input: { x: Number.NaN } })).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses short keys", () => {
    const short: ApprovalKey = { kid: "short", secret: new Uint8Array(16) };
    expect(() =>
      signApproval({ key: short, approval_id: "a", run_id: "r", tool_call_id: "t", input: {} }),
    ).toThrow(/shorter than 32 bytes/);
  });
});
