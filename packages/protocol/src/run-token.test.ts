import { describe, expect, it } from "vitest";
import {
  CAPABILITY_RUN_TOKEN,
  MAX_RUN_TOKEN_TTL_SECONDS,
  RUN_TOKEN_HEADER,
  RUN_TOKEN_TYP,
  decodeSandboxFrame,
  decodeServerFrame,
  encodeFrame,
  runTokenClaimsSchema,
  runTokenGrantSchema,
  type RunTokenClaims,
} from "./index.js";
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
// Signing and verification (Ed25519, KOBE-521) are tested in @kobe/session-token.
const GRANT = { token: "eyJhbGciOiJFZERTQSJ9.e30.sig", expires_at: "2026-10-01T00:00:00Z" };

describe("run token format", () => {
  it("names the header, capability and signed typ", () => {
    expect(RUN_TOKEN_HEADER).toBe("x-kobe-run-token");
    expect(CAPABILITY_RUN_TOKEN).toBe("run_token");
    expect(RUN_TOKEN_TYP).toBe("krt2");
  });

  it("rejects a token with the wrong claims shape", () => {
    expect(runTokenClaimsSchema.safeParse(CLAIMS).success).toBe(true);
    expect(runTokenClaimsSchema.safeParse({ ...CLAIMS, extra: 1 }).success).toBe(false);
    expect(runTokenClaimsSchema.safeParse({ ...CLAIMS, aud: "kobe.mcp-proxy" }).success).toBe(
      false,
    );
    expect(runTokenGrantSchema.safeParse(GRANT).success).toBe(true);
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
    const grant = GRANT;
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
  it("requires exp > iat and a bounded lifetime", () => {
    const long = { ...CLAIMS, exp: CLAIMS.iat + MAX_RUN_TOKEN_TTL_SECONDS + 1 };
    const inverted = { ...CLAIMS, exp: CLAIMS.iat };
    const max = { ...CLAIMS, exp: CLAIMS.iat + MAX_RUN_TOKEN_TTL_SECONDS };
    expect(runTokenClaimsSchema.safeParse(long).success).toBe(false);
    expect(runTokenClaimsSchema.safeParse(inverted).success).toBe(false);
    expect(runTokenClaimsSchema.safeParse(max).success).toBe(true);
  });
});
