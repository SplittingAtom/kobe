import { createHmac, createPublicKey, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_TOKEN_LENGTH,
  SessionKeyError,
  SessionTokenError,
  generateSessionKeyPair,
  keyId,
  loadSigningKey,
  loadVerifyKeys,
  mergeVerifyKeys,
  signSessionToken,
  signingKeyEnvName,
  verifyKeyEnvName,
  verifyKeysFromEnv,
  verifyKeysOf,
  verifySessionToken,
} from "./index.js";

const PAIR = generateSessionKeyPair();
const OTHER = generateSessionKeyPair();
const NOW = 1_790_000_000;
const claims = {
  iss: "kobe-server" as const,
  aud: "kobe.egress-proxy" as const,
  sub: "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192",
  team_id: "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e",
  user_id: "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70",
  iat: NOW,
  exp: NOW + 900,
  jti: "abcdefghijklmnopqrstuv",
};
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const header = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString()) as unknown;

describe("@kobe/session-token (EdDSA, KOBE-513)", () => {
  it("signs EdDSA with the key id and round-trips with the public key only", () => {
    const token = signSessionToken(claims, PAIR.signing);
    expect(header(token)).toEqual({ alg: "EdDSA", typ: "JWT", kid: PAIR.signing.kid });
    expect(
      verifySessionToken(token, "kobe.egress-proxy", loadVerifyKeys(PAIR.publicPem), NOW),
    ).toEqual(claims);
  });

  it("refuses another audience, another key, expiry and oversized input", () => {
    const token = signSessionToken(claims, PAIR.signing);
    expect(() => verifySessionToken(token, "kobe.mcp-proxy", PAIR.verify, NOW)).toThrow(
      SessionTokenError,
    );
    expect(() => verifySessionToken(token, "kobe.egress-proxy", OTHER.verify, NOW)).toThrow(
      /unknown key id/,
    );
    expect(() => verifySessionToken(token, "kobe.egress-proxy", PAIR.verify, NOW + 900)).toThrow(
      /expired/,
    );
    expect(() =>
      verifySessionToken(
        "a".repeat(MAX_SESSION_TOKEN_LENGTH + 1),
        "kobe.egress-proxy",
        PAIR.verify,
        NOW,
      ),
    ).toThrow(/too long/);
  });

  it("refuses a tampered payload or signature", () => {
    const [h, , s] = signSessionToken(claims, PAIR.signing).split(".");
    const forged = `${h}.${b64({ ...claims, user_id: "9d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70" })}.${s}`;
    expect(() => verifySessionToken(forged, "kobe.egress-proxy", PAIR.verify, NOW)).toThrow(
      /signature/,
    );
    // Change the last signature character to a different valid one, so the tamper is never a no-op
    // (a random signature ends in "AA" about once in 256 runs).
    const sig = s ?? "";
    const flipped = `${h}.${b64(claims)}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    expect(() => verifySessionToken(flipped, "kobe.egress-proxy", PAIR.verify, NOW)).toThrow(
      /signature/,
    );
  });

  it("a holder of the public key cannot produce a token that verifies", () => {
    const publicPem = PAIR.publicPem;
    const kid = PAIR.signing.kid;
    const input = `${b64({ alg: "EdDSA", typ: "JWT", kid })}.${b64(claims)}`;
    // The public key bytes used as an HMAC secret (alg confusion), as HS256, or no signature.
    const forgeries = [
      `${input}.${createHmac("sha256", publicPem).update(input).digest("base64url")}`,
      `${b64({ alg: "HS256", typ: "JWT", kid })}.${b64(claims)}.${createHmac("sha256", publicPem)
        .update(`${b64({ alg: "HS256", typ: "JWT", kid })}.${b64(claims)}`)
        .digest("base64url")}`,
      `${b64({ alg: "none", typ: "JWT", kid })}.${b64(claims)}.`,
      `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.${createHmac("sha256", publicPem)
        .update(`${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`)
        .digest("base64url")}`,
    ];
    for (const token of forgeries) {
      expect(() => verifySessionToken(token, "kobe.egress-proxy", PAIR.verify, NOW)).toThrow(
        SessionTokenError,
      );
    }
    // A public key cannot even be loaded as a signing key.
    expect(() => loadSigningKey(publicPem)).toThrow(SessionKeyError);
    expect(() => sign(null, Buffer.from(input), createPublicKey(publicPem) as never)).toThrow();
  });

  it("pins the header: alg none, HS256 and extra header fields are refused", () => {
    const payload = b64(claims);
    for (const h of [
      { alg: "none", typ: "JWT", kid: PAIR.signing.kid },
      { alg: "HS256", typ: "JWT", kid: PAIR.signing.kid },
      { alg: "EdDSA", typ: "JWT" },
      { alg: "EdDSA", typ: "JWT", kid: PAIR.signing.kid, jku: "https://evil.example/keys" },
      { alg: "EdDSA", typ: "JWT", kid: "../../etc/passwd" },
    ]) {
      const input = `${b64(h)}.${payload}`;
      const sig = sign(null, Buffer.from(input), PAIR.signing.privateKey).toString("base64url");
      expect(() =>
        verifySessionToken(`${input}.${sig}`, "kobe.egress-proxy", PAIR.verify, NOW),
      ).toThrow(/header/);
    }
  });

  it("rotation: a verifier holding the current and previous public keys accepts both", () => {
    const bundle = `${OTHER.publicPem}\n${PAIR.publicPem}`;
    const keys = loadVerifyKeys(bundle);
    expect([...keys.keys()].sort()).toEqual([OTHER.signing.kid, PAIR.signing.kid].sort());
    for (const p of [PAIR, OTHER]) {
      const token = signSessionToken(claims, p.signing);
      expect(verifySessionToken(token, "kobe.egress-proxy", keys, NOW).jti).toBe(claims.jti);
    }
    const merged = mergeVerifyKeys(verifyKeysOf(PAIR.signing), OTHER.verify);
    expect(merged.size).toBe(2);
  });
});

describe("session keys", () => {
  it("derives the same kid on both sides and loads certificates", () => {
    expect(keyId(createPublicKey(PAIR.publicPem))).toBe(PAIR.signing.kid);
    expect([...verifyKeysOf(PAIR.signing).keys()]).toEqual([PAIR.signing.kid]);
  });

  it("refuses private keys in a verify set and non-Ed25519 or malformed keys", () => {
    expect(() => loadVerifyKeys(`${PAIR.publicPem}${PAIR.privatePem}`)).toThrow(/public keys only/);
    expect(() => loadVerifyKeys("not a pem")).toThrow(SessionKeyError);
    expect(() =>
      loadVerifyKeys([PAIR, OTHER, PAIR, OTHER, PAIR].map((p) => p.publicPem).join("")),
    ).toThrow(/more than/);
    expect(() => loadSigningKey(`${PAIR.privatePem}${OTHER.privatePem}`)).toThrow(SessionKeyError);
    expect(() => loadSigningKey("x".repeat(48))).toThrow(SessionKeyError);
    const rsa = `-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA\n-----END PRIVATE KEY-----`;
    expect(() => loadSigningKey(rsa)).toThrow(SessionKeyError);
    try {
      loadSigningKey(rsa);
    } catch (e) {
      expect((e as Error).message).not.toContain("MIIB");
    }
  });

  it("names the env per audience and reads a verifier's keys from it", () => {
    expect(signingKeyEnvName("kobe.sandbox-wire")).toBe("KOBE_SESSION_SIGNING_KEY_SANDBOX_WIRE");
    expect(verifyKeyEnvName("kobe.mcp-proxy")).toBe("KOBE_SESSION_VERIFY_KEY_MCP_PROXY");
    const name = "KOBE_SESSION_VERIFY_KEY_MCP_PROXY";
    expect(
      verifyKeysFromEnv({ [name]: PAIR.publicPem }, "kobe.mcp-proxy").has(PAIR.signing.kid),
    ).toBe(true);
    const escaped = PAIR.publicPem.replace(/\n/g, "\\n");
    expect(verifyKeysFromEnv({ [name]: escaped }, "kobe.mcp-proxy").size).toBe(1);
    expect(() => verifyKeysFromEnv({}, "kobe.mcp-proxy")).toThrow(
      new RegExp(`${name} is required`),
    );
    let message = "";
    try {
      verifyKeysFromEnv({ [name]: PAIR.privatePem }, "kobe.mcp-proxy");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/public keys only/);
    expect(message).not.toContain(PAIR.privatePem.split("\n")[1]);
  });
});
