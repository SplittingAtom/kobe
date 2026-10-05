import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_RUN_TOKEN,
  MAX_RUN_TOKEN_TTL_SECONDS,
  RUN_TOKEN_HEADER,
  RUN_TOKEN_SKEW_SECONDS,
  decodeSandboxFrame,
  decodeServerFrame,
  encodeFrame,
  runTokenClaimsSchema,
  runTokenGrantSchema,
  type RunTokenClaims,
} from "./index.js";
import { deriveRunTokenKey, signRunToken, verifyRunToken } from "./node/index.js";
import { EXAMPLE_IDS } from "./testing/index.js";

const NOW = 1_800_000_000;
const CLAIMS: RunTokenClaims = {
  iss: "kobe-server",
  aud: "kobe.model-gateway",
  run_id: EXAMPLE_IDS.run,
  team_id: EXAMPLE_IDS.team,
  sandbox_id: EXAMPLE_IDS.sandbox,
  iat: NOW,
  exp: NOW + 900,
  jti: "jti-0123456789abcdef",
};
const KEY = deriveRunTokenKey(new Uint8Array(32).fill(7));
const OTHER = deriveRunTokenKey(new Uint8Array(32).fill(8));

describe("run token format", () => {
  it("names the header and capability", () => {
    expect(RUN_TOKEN_HEADER).toBe("x-kobe-run-token");
    expect(CAPABILITY_RUN_TOKEN).toBe("run_token");
  });

  it("derives a stable, domain-separated key and rejects short secrets", () => {
    expect(deriveRunTokenKey(new Uint8Array(32).fill(7))).toEqual(KEY);
    expect(KEY).not.toEqual(new Uint8Array(32).fill(7));
    expect(() => deriveRunTokenKey(new Uint8Array(8))).toThrow();
  });

  it("round-trips sign and verify", () => {
    const grant = signRunToken(KEY, CLAIMS);
    expect(runTokenGrantSchema.safeParse(grant).success).toBe(true);
    expect(grant.token.startsWith("krt1.")).toBe(true);
    expect(grant.expires_at).toBe(new Date((NOW + 900) * 1000).toISOString());
    expect(verifyRunToken(KEY, grant.token, NOW + 1)).toEqual({ ok: true, claims: CLAIMS });
  });

  it("rejects expiry, future iat and wrong key", () => {
    const { token } = signRunToken(KEY, CLAIMS);
    expect(verifyRunToken(KEY, token, NOW + 900)).toEqual({ ok: false, reason: "expired" });
    expect(verifyRunToken(KEY, token, NOW - RUN_TOKEN_SKEW_SECONDS - 1)).toEqual({
      ok: false,
      reason: "not_yet_valid",
    });
    expect(verifyRunToken(OTHER, token, NOW)).toEqual({ ok: false, reason: "bad_mac" });
  });

  it("rejects tampered payloads, macs and prefixes", () => {
    const { token } = signRunToken(KEY, CLAIMS);
    const [p, payload, mac] = token.split(".") as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...CLAIMS, run_id: EXAMPLE_IDS.approval }),
    ).toString("base64url");
    const bad = [
      `${p}.${forged}.${mac}`,
      `${p}.${payload}.${mac.slice(0, -2)}AA`,
      `krt2.${payload}.${mac}`,
      `${p}.${payload}`,
      `${token}.x`,
      "",
      "x".repeat(2000),
    ];
    for (const t of bad) expect(verifyRunToken(KEY, t, NOW).ok).toBe(false);
    expect(verifyRunToken(KEY, 42, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a correctly signed token with the wrong claims shape", () => {
    expect(runTokenClaimsSchema.safeParse({ ...CLAIMS, extra: 1 }).success).toBe(false);
    expect(() => signRunToken(KEY, { ...CLAIMS, aud: "kobe.mcp-proxy" } as never)).toThrow();
  });
});

describe("run.start run_token on the wire", () => {
  const base = {
    v: 1,
    type: "run.start",
    command_id: "c1",
    run_id: EXAMPLE_IDS.run,
    thread_id: EXAMPLE_IDS.thread,
    message: "hi",
  };
  const hello = {
    v: 1,
    type: "hello",
    sandbox_id: EXAMPLE_IDS.sandbox,
    agent_version: "1",
    pi_version: "1.0.0",
    runs: [],
  };

  it("accepts run.start with or without the grant (old servers, old agents)", () => {
    const grant = signRunToken(KEY, CLAIMS);
    const withToken = decodeServerFrame(JSON.stringify({ ...base, run_token: grant }));
    expect(withToken).toMatchObject({ ok: true });
    expect(decodeServerFrame(JSON.stringify(base))).toMatchObject({ ok: true });
    expect(encodeFrame({ ...base, run_token: grant } as never)).toContain('"run_token"');
  });

  it("rejects malformed grants", () => {
    for (const run_token of [{ token: "", expires_at: "2026-10-01T00:00:00Z" }, { token: "a" }])
      expect(decodeServerFrame(JSON.stringify({ ...base, run_token }))).toMatchObject({
        ok: false,
      });
  });

  it("an agent advertises the capability in hello", () => {
    expect(
      decodeSandboxFrame(JSON.stringify({ ...hello, capabilities: [CAPABILITY_RUN_TOKEN] })),
    ).toMatchObject({ ok: true });
  });
});

describe("run token lifetime bounds", () => {
  it("requires exp > iat and a bounded lifetime in schema, sign and verify", () => {
    const long = { ...CLAIMS, exp: CLAIMS.iat + MAX_RUN_TOKEN_TTL_SECONDS + 1 };
    const inverted = { ...CLAIMS, exp: CLAIMS.iat };
    const max = { ...CLAIMS, exp: CLAIMS.iat + MAX_RUN_TOKEN_TTL_SECONDS };
    expect(runTokenClaimsSchema.safeParse(long).success).toBe(false);
    expect(runTokenClaimsSchema.safeParse(inverted).success).toBe(false);
    expect(runTokenClaimsSchema.safeParse(max).success).toBe(true);
    expect(() => signRunToken(KEY, long)).toThrow();
    // A token signed with the right key but out-of-bounds claims must still fail verification.
    const payload = Buffer.from(JSON.stringify(long)).toString("base64url");
    const signed = `krt1.${payload}`;
    const mac = createHmac("sha256", KEY).update(signed).digest("base64url");
    expect(verifyRunToken(KEY, `${signed}.${mac}`, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
