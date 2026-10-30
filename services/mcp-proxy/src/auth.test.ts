import { describe, expect, it } from "vitest";
import { generateSessionKeyPair, signSessionToken } from "@kobe/session-token";
import {
  EXPIRED_TOKEN_MAX_AGE_SECONDS,
  bearerToken,
  isExpiredSandboxToken,
  verifySandboxToken,
} from "./auth.js";

const PAIR = generateSessionKeyPair();
const KEY = PAIR.signing;
const PUB = PAIR.verify;
const claims = (aud: "kobe.mcp-proxy" | "kobe.sandbox-wire") => ({
  iss: "kobe-server" as const,
  aud,
  sub: "00000000-0000-4000-8000-000000000001",
  team_id: "00000000-0000-4000-8000-000000000002",
  user_id: "00000000-0000-4000-8000-000000000003",
  iat: 1_000,
  exp: 2_000,
  jti: "jti-0123456789abcdef",
});

describe("sandbox token at the proxy", () => {
  it("extracts a Bearer token and nothing else", () => {
    expect(bearerToken("Bearer a.b.c")).toBe("a.b.c");
    for (const h of [undefined, "", "Basic a.b.c", "Bearer a b", "Bearer "]) {
      expect(bearerToken(h)).toBeUndefined();
    }
  });

  it("accepts only an unexpired kobe.mcp-proxy token signed with the proxy's key", () => {
    expect(
      verifySandboxToken(signSessionToken(claims("kobe.mcp-proxy"), KEY), PUB, 1_500)?.sub,
    ).toBe(claims("kobe.mcp-proxy").sub);
    expect(
      verifySandboxToken(signSessionToken(claims("kobe.mcp-proxy"), KEY), PUB, 2_500),
    ).toBeUndefined();
    expect(
      verifySandboxToken(signSessionToken(claims("kobe.sandbox-wire"), KEY), PUB, 1_500),
    ).toBeUndefined();
    expect(
      verifySandboxToken(
        signSessionToken(claims("kobe.mcp-proxy"), generateSessionKeyPair().signing),
        PUB,
        1_500,
      ),
    ).toBeUndefined();
    expect(verifySandboxToken(undefined, PUB)).toBeUndefined();
  });
});

describe("expired sandbox token (the 404 on a live MCP session)", () => {
  const token = signSessionToken(claims("kobe.mcp-proxy"), KEY);
  const exp = claims("kobe.mcp-proxy").exp;

  it("caps the age at twice the session token TTL", () => {
    expect(EXPIRED_TOKEN_MAX_AGE_SECONDS).toBe(2 * 15 * 60);
  });

  it("is true for a genuine token expired within the cap, including exactly at it", () => {
    expect(isExpiredSandboxToken(token, PUB, exp + 1)).toBe(true);
    expect(isExpiredSandboxToken(token, PUB, exp + EXPIRED_TOKEN_MAX_AGE_SECONDS)).toBe(true);
  });

  it("is false past the cap, so the caller answers 401", () => {
    expect(isExpiredSandboxToken(token, PUB, exp + EXPIRED_TOKEN_MAX_AGE_SECONDS + 1)).toBe(false);
  });

  it("is false for a live, forged or wrong-audience token and for none", () => {
    expect(isExpiredSandboxToken(token, PUB, exp - 1)).toBe(false);
    expect(isExpiredSandboxToken(token, generateSessionKeyPair().verify, exp + 1)).toBe(false);
    expect(
      isExpiredSandboxToken(signSessionToken(claims("kobe.sandbox-wire"), KEY), PUB, exp + 1),
    ).toBe(false);
    expect(isExpiredSandboxToken(undefined, PUB, exp + 1)).toBe(false);
  });
});
