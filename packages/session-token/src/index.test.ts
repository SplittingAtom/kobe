import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_TOKEN_LENGTH,
  SessionTokenError,
  signSessionToken,
  verifySessionToken,
} from "./index.js";

const KEY = "k".repeat(40);
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

describe("@kobe/session-token", () => {
  it("round-trips a token for its audience and key", () => {
    const token = signSessionToken(claims, KEY);
    expect(verifySessionToken(token, "kobe.egress-proxy", KEY, NOW)).toEqual(claims);
  });

  it("refuses another audience, another key, expiry and oversized input", () => {
    const token = signSessionToken(claims, KEY);
    expect(() => verifySessionToken(token, "kobe.mcp-proxy", KEY, NOW)).toThrow(SessionTokenError);
    expect(() => verifySessionToken(token, "kobe.egress-proxy", "x".repeat(40), NOW)).toThrow(
      /signature/,
    );
    expect(() => verifySessionToken(token, "kobe.egress-proxy", KEY, NOW + 900)).toThrow(/expired/);
    expect(() =>
      verifySessionToken("a".repeat(MAX_SESSION_TOKEN_LENGTH + 1), "kobe.egress-proxy", KEY, NOW),
    ).toThrow(/too long/);
  });

  it("pins the header: alg none and extra header fields are refused", () => {
    const payload = b64(claims);
    for (const header of [
      { alg: "none", typ: "JWT" },
      { alg: "HS256", typ: "JWT", kid: "x" },
    ]) {
      const input = `${b64(header)}.${payload}`;
      const sig = createHmac("sha256", KEY).update(input).digest("base64url");
      expect(() => verifySessionToken(`${input}.${sig}`, "kobe.egress-proxy", KEY, NOW)).toThrow(
        /header/,
      );
    }
  });
});
