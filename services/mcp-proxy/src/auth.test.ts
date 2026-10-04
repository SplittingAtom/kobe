import { describe, expect, it } from "vitest";
import { signSessionToken } from "@kobe/session-token";
import { bearerToken, verifySandboxToken } from "./auth.js";

const KEY = "k".repeat(40);
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
      verifySandboxToken(signSessionToken(claims("kobe.mcp-proxy"), KEY), KEY, 1_500)?.sub,
    ).toBe(claims("kobe.mcp-proxy").sub);
    expect(
      verifySandboxToken(signSessionToken(claims("kobe.mcp-proxy"), KEY), KEY, 2_500),
    ).toBeUndefined();
    expect(
      verifySandboxToken(signSessionToken(claims("kobe.sandbox-wire"), KEY), KEY, 1_500),
    ).toBeUndefined();
    expect(
      verifySandboxToken(signSessionToken(claims("kobe.mcp-proxy"), "o".repeat(40)), KEY, 1_500),
    ).toBeUndefined();
    expect(verifySandboxToken(undefined, KEY)).toBeUndefined();
  });
});
