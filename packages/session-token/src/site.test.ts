import { describe, expect, it } from "vitest";
import {
  SITE_EGRESS_TOKEN_TTL_SECONDS,
  SessionTokenError,
  signSessionToken,
  signSiteEgressToken,
  verifySessionToken,
  verifySiteEgressToken,
} from "./index.js";
import { signJws } from "./jws.js";

const KEY = "k".repeat(40);
const NOW = 1_790_000_000;

describe("site egress tokens (KOBE-343)", () => {
  it("round-trips for its purpose, with a short lifetime", () => {
    const token = signSiteEgressToken("skill-mirror", KEY, NOW);
    const claims = verifySiteEgressToken(token, KEY, NOW);
    expect(claims).toMatchObject({
      iss: "kobe-server",
      aud: "kobe.egress-proxy.site",
      sub: "skill-mirror",
      iat: NOW,
      exp: NOW + SITE_EGRESS_TOKEN_TTL_SECONDS,
    });
    expect(SITE_EGRESS_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(300);
  });

  it("refuses expiry, another key and unknown purposes", () => {
    const token = signSiteEgressToken("skill-mirror", KEY, NOW);
    expect(() => verifySiteEgressToken(token, KEY, NOW + SITE_EGRESS_TOKEN_TTL_SECONDS)).toThrow(
      /expired/,
    );
    expect(() => verifySiteEgressToken(token, "x".repeat(40), NOW)).toThrow(/signature/);
    const other = signJws(
      { iss: "kobe-server", aud: "kobe.egress-proxy.site", sub: "anything", iat: NOW, exp: NOW + 60, jti: "a".repeat(24) },
      KEY,
    );
    expect(() => verifySiteEgressToken(other, KEY, NOW)).toThrow(SessionTokenError);
  });

  it("is never a sandbox session token, and a sandbox token is never a site token", () => {
    const site = signSiteEgressToken("skill-mirror", KEY, NOW);
    expect(() => verifySessionToken(site, "kobe.egress-proxy", KEY, NOW)).toThrow(/contract/);
    const sandbox = signSessionToken(
      {
        iss: "kobe-server",
        aud: "kobe.egress-proxy",
        sub: "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192",
        team_id: "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e",
        user_id: "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70",
        iat: NOW,
        exp: NOW + 900,
        jti: "abcdefghijklmnopqrstuv",
      },
      KEY,
    );
    expect(() => verifySiteEgressToken(sandbox, KEY, NOW)).toThrow(/claims/);
  });
});
