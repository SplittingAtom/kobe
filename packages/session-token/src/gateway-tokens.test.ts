import { createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RUN_TOKEN_MAX_CHARS,
  RUN_TOKEN_SKEW_SECONDS,
  SERVER_CALL_AUDIENCE,
  SERVER_CALL_TOKEN_MAX_CHARS,
  SERVER_CALL_TOKEN_SKEW_SECONDS,
  type RunTokenClaims,
  type ServerCallClaims,
} from "@kobe/protocol";
import {
  generateSessionKeyPair,
  loadVerifyKeys,
  mergeVerifyKeys,
  signRunToken,
  signServerCallToken,
  signSessionToken,
  verifyRunToken,
  verifyServerCallToken,
  verifySessionToken,
} from "./index.js";

const PAIR = generateSessionKeyPair();
const OTHER = generateSessionKeyPair();
const NOW = 1_800_000_000;
const TEAM = "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
const USER = "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70";
const SANDBOX = "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192";
const RUN = "6a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const THREAD = "7b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e";
const RUN_CLAIMS: RunTokenClaims = {
  iss: "kobe-server",
  aud: "kobe.model-gateway",
  run_id: RUN,
  team_id: TEAM,
  sandbox_id: SANDBOX,
  iat: NOW,
  exp: NOW + 900,
  jti: "jti-0123456789abcdef",
};
const SC_CLAIMS: ServerCallClaims = {
  iss: "kobe-server",
  aud: SERVER_CALL_AUDIENCE,
  purpose: "title",
  team_id: TEAM,
  user_id: USER,
  thread_id: THREAD,
  run_id: RUN,
  model: "openai/gpt-test",
  max_output_tokens: 48,
  iat: NOW,
  exp: NOW + 30,
  jti: "jti-0123456789abcdef",
};
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const header = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString()) as unknown;

/** The pre-KOBE-521 HMAC format (`krt1` / `ksc1`), keyed from a shared master secret. */
function hmacEraToken(prefix: string, info: string, claims: unknown): string {
  const key = new Uint8Array(hkdfSync("sha256", "m".repeat(40), new Uint8Array(0), info, 32));
  const signed = `${prefix}.${b64(claims)}`;
  return `${signed}.${createHmac("sha256", key).update(signed).digest("base64url")}`;
}

describe("run tokens (Ed25519, KOBE-521)", () => {
  it("are signed EdDSA with typ krt2 and verify with the public key only", () => {
    const grant = signRunToken(PAIR.signing, RUN_CLAIMS);
    expect(header(grant.token)).toEqual({ alg: "EdDSA", typ: "krt2", kid: PAIR.signing.kid });
    expect(grant.expires_at).toBe(new Date((NOW + 900) * 1000).toISOString());
    expect(grant.token.length).toBeLessThanOrEqual(RUN_TOKEN_MAX_CHARS);
    expect(verifyRunToken(loadVerifyKeys(PAIR.publicPem), grant.token, NOW + 1)).toEqual({
      ok: true,
      claims: RUN_CLAIMS,
    });
  });

  it("refuses expiry, a future iat, another key and tampering", () => {
    const { token } = signRunToken(PAIR.signing, RUN_CLAIMS);
    expect(verifyRunToken(PAIR.verify, token, NOW + 900)).toEqual({ ok: false, reason: "expired" });
    expect(verifyRunToken(PAIR.verify, token, NOW - RUN_TOKEN_SKEW_SECONDS - 1)).toEqual({
      ok: false,
      reason: "not_yet_valid",
    });
    expect(verifyRunToken(OTHER.verify, token, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const [h, , s] = token.split(".") as [string, string, string];
    const forged = `${h}.${b64({ ...RUN_CLAIMS, run_id: THREAD })}.${s}`;
    for (const t of [forged, `${token}.x`, token.slice(0, -2), "", "nope"]) {
      expect(verifyRunToken(PAIR.verify, t, NOW).ok, t).toBe(false);
    }
    expect(verifyRunToken(PAIR.verify, "x".repeat(RUN_TOKEN_MAX_CHARS + 1), NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyRunToken(PAIR.verify, 42, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses claims outside the contract when signing, and a signed token of the wrong shape", () => {
    expect(() =>
      signRunToken(PAIR.signing, { ...RUN_CLAIMS, aud: "kobe.mcp-proxy" } as never),
    ).toThrow();
    expect(() => signRunToken(PAIR.signing, { ...RUN_CLAIMS, exp: NOW + 86_401 })).toThrow();
  });

  it("refuses HMAC-era krt1 tokens, whatever key minted them", () => {
    const old = hmacEraToken("krt1", "kobe/run-token/v1", RUN_CLAIMS);
    expect(verifyRunToken(PAIR.verify, old, NOW).ok).toBe(false);
  });

  it("a holder of the public key cannot mint one (HS256 with the public key, alg none)", () => {
    const body = b64(RUN_CLAIMS);
    const spki =
      [...PAIR.verify.values()][0]?.export({ type: "spki", format: "der" }) ?? Buffer.alloc(1);
    for (const alg of ["HS256", "none"]) {
      const head = b64({ alg, typ: "krt2", kid: PAIR.signing.kid });
      const mac = createHmac("sha256", spki).update(`${head}.${body}`).digest("base64url");
      expect(verifyRunToken(PAIR.verify, `${head}.${body}.${mac}`, NOW).ok).toBe(false);
      expect(verifyRunToken(PAIR.verify, `${head}.${body}.`, NOW).ok).toBe(false);
    }
  });

  it("rotation: a bundle with the old and new public key accepts both kids; without it, unknown", () => {
    const next = generateSessionKeyPair();
    const both = mergeVerifyKeys(PAIR.verify, next.verify);
    const old = signRunToken(PAIR.signing, RUN_CLAIMS).token;
    const fresh = signRunToken(next.signing, RUN_CLAIMS).token;
    expect(verifyRunToken(both, old, NOW).ok).toBe(true);
    expect(verifyRunToken(both, fresh, NOW).ok).toBe(true);
    expect(verifyRunToken(next.verify, old, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("server-call tokens (Ed25519, KOBE-521)", () => {
  it("are signed EdDSA with typ ksc2 and verify with the public key only", () => {
    const token = signServerCallToken(PAIR.signing, SC_CLAIMS);
    expect(header(token)).toEqual({ alg: "EdDSA", typ: "ksc2", kid: PAIR.signing.kid });
    expect(verifyServerCallToken(loadVerifyKeys(PAIR.publicPem), token, NOW + 1)).toEqual({
      ok: true,
      claims: SC_CLAIMS,
    });
  });

  it("refuses expiry, a future iat, another key, oversize and HMAC-era ksc1 tokens", () => {
    const token = signServerCallToken(PAIR.signing, SC_CLAIMS);
    expect(verifyServerCallToken(PAIR.verify, token, NOW + 30)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(
      verifyServerCallToken(PAIR.verify, token, NOW - SERVER_CALL_TOKEN_SKEW_SECONDS - 1),
    ).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(verifyServerCallToken(OTHER.verify, token, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(
      verifyServerCallToken(PAIR.verify, "x".repeat(SERVER_CALL_TOKEN_MAX_CHARS + 1), NOW),
    ).toEqual({ ok: false, reason: "malformed" });
    const old = hmacEraToken("ksc1", "kobe/server-call-token/v1", SC_CLAIMS);
    expect(verifyServerCallToken(PAIR.verify, old, NOW).ok).toBe(false);
    expect(() =>
      signServerCallToken(PAIR.signing, { ...SC_CLAIMS, max_output_tokens: 10_000 }),
    ).toThrow();
  });

  it("fits the size cap with the longest claims the contract allows (256-char model and jti)", () => {
    const model = `${"p".repeat(64)}/${"m".repeat(191)}`;
    const token = signServerCallToken(PAIR.signing, {
      ...SC_CLAIMS,
      purpose: "eval_judge",
      model,
      max_output_tokens: 2048,
      jti: "j".repeat(128),
    });
    expect(token.length).toBeLessThanOrEqual(SERVER_CALL_TOKEN_MAX_CHARS);
    expect(verifyServerCallToken(PAIR.verify, token, NOW).ok).toBe(true);
  });
});

describe("no token kind verifies as another under the shared model-gateway key", () => {
  const session = signSessionToken(
    {
      iss: "kobe-server",
      aud: "kobe.model-gateway",
      sub: SANDBOX,
      team_id: TEAM,
      user_id: USER,
      iat: NOW,
      exp: NOW + 900,
      jti: "abcdefghijklmnopqrstuv",
    },
    PAIR.signing,
  );
  const run = signRunToken(PAIR.signing, RUN_CLAIMS).token;
  const sc = signServerCallToken(PAIR.signing, SC_CLAIMS);

  it("a session token is neither a run token nor a server-call token", () => {
    expect(verifyRunToken(PAIR.verify, session, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(verifyServerCallToken(PAIR.verify, session, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("a run token is neither a session token nor a server-call token, and the reverse", () => {
    expect(() => verifySessionToken(run, "kobe.model-gateway", PAIR.verify, NOW)).toThrow();
    expect(verifyServerCallToken(PAIR.verify, run, NOW).ok).toBe(false);
    expect(() => verifySessionToken(sc, "kobe.model-gateway", PAIR.verify, NOW)).toThrow();
    expect(verifyRunToken(PAIR.verify, sc, NOW).ok).toBe(false);
  });

  it("re-labelling the typ breaks the signature", () => {
    const [, body, sig] = run.split(".") as [string, string, string];
    const relabelled = `${b64({ alg: "EdDSA", typ: "ksc2", kid: PAIR.signing.kid })}.${body}.${sig}`;
    expect(verifyServerCallToken(PAIR.verify, relabelled, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});
