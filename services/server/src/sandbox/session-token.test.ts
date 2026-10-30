import { createHmac, sign as edSign } from "node:crypto";
import { SESSION_TOKEN_AUDIENCES, sessionTokenClaimsSchema } from "@kobe/protocol";
import { generateSessionKeyPair, loadVerifyKeys } from "@kobe/session-token";
import { describe, expect, it } from "vitest";
import { KEYS, KEY_PAIRS, VERIFY_KEYS } from "../testing/sandbox-fixtures.js";
import {
  SESSION_TOKEN_TTL_SECONDS,
  SessionTokenError,
  issueSessionTokens,
  verifySessionToken,
} from "./session-token.js";

const PRINCIPAL = {
  sandboxId: "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192",
  teamId: "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e",
  userId: "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70",
};
const NOW = new Date("2026-10-02T00:00:00Z");
const NOW_S = NOW.getTime() / 1000;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
/** A valid Ed25519 signature by the wire key over any header and payload (header pinning tests). */
const sign = (input: string) =>
  edSign(null, Buffer.from(input), KEYS["kobe.sandbox-wire"].privateKey).toString("base64url");
const KID = KEYS["kobe.sandbox-wire"].kid;

const issued = issueSessionTokens(PRINCIPAL, KEYS, NOW);
const wire = issued.tokens["kobe.sandbox-wire"];

describe("session tokens", () => {
  it("issues one token per audience with the contract's claims", () => {
    expect(Object.keys(issued.tokens).sort()).toEqual([...SESSION_TOKEN_AUDIENCES].sort());
    for (const aud of SESSION_TOKEN_AUDIENCES) {
      const claims = verifySessionToken(issued.tokens[aud], aud, VERIFY_KEYS[aud], NOW_S);
      expect(sessionTokenClaimsSchema.parse(claims)).toMatchObject({
        iss: "kobe-server",
        aud,
        sub: PRINCIPAL.sandboxId,
        team_id: PRINCIPAL.teamId,
        user_id: PRINCIPAL.userId,
        iat: NOW_S,
        exp: NOW_S + SESSION_TOKEN_TTL_SECONDS,
      });
    }
    expect(issued.expiresAt).toEqual(new Date((NOW_S + SESSION_TOKEN_TTL_SECONDS) * 1000));
    const jtis = SESSION_TOKEN_AUDIENCES.map(
      (aud) => verifySessionToken(issued.tokens[aud], aud, VERIFY_KEYS[aud], NOW_S).jti,
    );
    expect(new Set(jtis).size).toBe(4);
  });

  it("issues tokens for a shorter TTL when asked (e2e rotation)", () => {
    const short = issueSessionTokens(PRINCIPAL, KEYS, NOW, 15);
    const claims = verifySessionToken(
      short.tokens["kobe.mcp-proxy"],
      "kobe.mcp-proxy",
      VERIFY_KEYS["kobe.mcp-proxy"],
      NOW_S,
    );
    expect(claims.exp).toBe(NOW_S + 15);
    expect(short.expiresAt).toEqual(new Date((NOW_S + 15) * 1000));
  });

  it("rejects a token presented to another audience, even with that audience's key", () => {
    expect(() =>
      verifySessionToken(wire, "kobe.mcp-proxy", VERIFY_KEYS["kobe.mcp-proxy"], NOW_S),
    ).toThrow(SessionTokenError);
    // Same key, wrong audience claim: still refused.
    expect(() =>
      verifySessionToken(wire, "kobe.mcp-proxy", VERIFY_KEYS["kobe.sandbox-wire"], NOW_S),
    ).toThrow(/audience/);
  });

  it("pins EdDSA: alg none, HS256 (also keyed with the public key) and extra headers are refused", () => {
    const [, payload] = wire.split(".") as [string, string, string];
    const key = VERIFY_KEYS["kobe.sandbox-wire"];
    const publicPem = KEY_PAIRS["kobe.sandbox-wire"].publicPem;
    const forge = (header: object, signature?: string) => {
      const input = `${b64(header)}.${payload}`;
      return `${input}.${signature ?? sign(input)}`;
    };
    const hmac = (header: object) => {
      const input = `${b64(header)}.${payload}`;
      return `${input}.${createHmac("sha256", publicPem).update(input).digest("base64url")}`;
    };
    for (const token of [
      forge({ alg: "none", typ: "JWT", kid: KID }, "AA"),
      `${b64({ alg: "none", typ: "JWT" })}.${payload}.`,
      forge({ alg: "HS512", typ: "JWT", kid: KID }),
      forge({ alg: "EdDSA", typ: "JWT" }),
      forge({ alg: "EdDSA", kid: KID }),
      forge({ alg: "EdDSA", typ: "JWT", kid: KID, jku: "https://evil.example/keys" }),
      forge({ alg: "EdDSA", typ: "JWT", kid: KID, jwk: { kty: "OKP" } }),
      hmac({ alg: "HS256", typ: "JWT" }),
      hmac({ alg: "HS256", typ: "JWT", kid: KID }),
      hmac({ alg: "EdDSA", typ: "JWT", kid: KID }),
    ]) {
      expect(() => verifySessionToken(token, "kobe.sandbox-wire", key, NOW_S)).toThrow(
        SessionTokenError,
      );
    }
  });

  it("rejects tampering, a wrong key, expiry and tokens from the future", () => {
    const [h, p, s] = wire.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
    const tampered = `${h}.${b64({ ...claims, user_id: PRINCIPAL.teamId })}.${s}`;
    const key = VERIFY_KEYS["kobe.sandbox-wire"];
    expect(() => verifySessionToken(tampered, "kobe.sandbox-wire", key, NOW_S)).toThrow(
      /signature/,
    );
    expect(() =>
      verifySessionToken(wire, "kobe.sandbox-wire", generateSessionKeyPair().verify, NOW_S),
    ).toThrow(/key id/);
    expect(() =>
      verifySessionToken(wire, "kobe.sandbox-wire", key, NOW_S + SESSION_TOKEN_TTL_SECONDS),
    ).toThrow(/expired/);
    expect(() => verifySessionToken(wire, "kobe.sandbox-wire", key, NOW_S - 120)).toThrow(/future/);
  });

  it("refuses validly signed payloads that break the claims contract", () => {
    const key = VERIFY_KEYS["kobe.sandbox-wire"];
    const input = `${b64({ alg: "EdDSA", typ: "JWT", kid: KID })}.${b64({ aud: "kobe.sandbox-wire", admin: true })}`;
    expect(() =>
      verifySessionToken(`${input}.${sign(input)}`, "kobe.sandbox-wire", key, NOW_S),
    ).toThrow(/contract/);
  });

  it("a verifier holding only the public key cannot mint a token for any sandbox (KOBE-513)", () => {
    // What a compromised proxy has: the PEM of its audience's public key, nothing else.
    const publicPem = KEY_PAIRS["kobe.mcp-proxy"].publicPem;
    const held = loadVerifyKeys(publicPem);
    const [h, p] = issued.tokens["kobe.mcp-proxy"].split(".") as [string, string, string];
    const victim = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
    const forgedPayload = b64({ ...victim, user_id: "9d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70" });
    const input = `${h}.${forgedPayload}`;
    for (const signature of [
      createHmac("sha256", publicPem).update(input).digest("base64url"),
      Buffer.alloc(64).toString("base64url"),
      issued.tokens["kobe.mcp-proxy"].split(".")[2] ?? "",
    ]) {
      expect(() =>
        verifySessionToken(`${input}.${signature}`, "kobe.mcp-proxy", held, NOW_S),
      ).toThrow(SessionTokenError);
    }
    // A fresh key pair of its own does not help either: its kid is unknown to every verifier.
    const own = generateSessionKeyPair();
    const minted = issueSessionTokens(PRINCIPAL, { ...KEYS, "kobe.mcp-proxy": own.signing }, NOW);
    expect(() =>
      verifySessionToken(minted.tokens["kobe.mcp-proxy"], "kobe.mcp-proxy", held, NOW_S),
    ).toThrow(/key id/);
  });

  it("refuses garbage and oversized input", () => {
    const key = VERIFY_KEYS["kobe.sandbox-wire"];
    for (const token of ["", "a.b", "a.b.c.d", "a b.c.d", "x".repeat(5000)]) {
      expect(() => verifySessionToken(token, "kobe.sandbox-wire", key, NOW_S)).toThrow(
        SessionTokenError,
      );
    }
  });
});
