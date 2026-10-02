import { signSessionToken } from "@kobe/session-token";
import { describe, expect, it } from "vitest";
import { authenticate, egressTokenVerifier } from "./auth.js";

const KEY = "e".repeat(40);
const now = Math.floor(Date.now() / 1000);
const claims = {
  iss: "kobe-server" as const,
  sub: "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192",
  team_id: "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e",
  user_id: "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70",
  iat: now,
  exp: now + 900,
  jti: "abcdefghijklmnopqrstuv",
};
const egressToken = signSessionToken({ ...claims, aud: "kobe.egress-proxy" }, KEY);
const verify = egressTokenVerifier(KEY);
const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const THREAD = "9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("authenticate", () => {
  it("accepts the egress token as Basic password or Bearer, and reads identity from it", () => {
    for (const header of [basic("kobe", egressToken), `Bearer ${egressToken}`]) {
      expect(authenticate(header, verify)).toEqual({
        ok: true,
        identity: {
          sandboxId: claims.sub,
          teamId: claims.team_id,
          userId: claims.user_id,
          threadHint: undefined,
          tokenId: claims.jti,
        },
      });
    }
  });

  it("takes a UUID user name as a thread hint, anything else as no hint", () => {
    const withHint = authenticate(basic(THREAD.toUpperCase(), egressToken), verify);
    expect(withHint.ok && withHint.identity.threadHint).toBe(THREAD);
    const noHint = authenticate(basic("not-a-thread", egressToken), verify);
    expect(noHint.ok && noHint.identity.threadHint).toBeUndefined();
  });

  it("refuses missing, malformed and invalid credentials", () => {
    expect(authenticate(undefined, verify)).toEqual({ ok: false, reason: "missing" });
    expect(authenticate("", verify)).toEqual({ ok: false, reason: "missing" });
    for (const bad of ["Basic", "Basic !!!", basic("kobe", ""), "Digest x", ["a", "b"]]) {
      expect(authenticate(bad, verify)).toEqual({ ok: false, reason: "malformed" });
    }
    expect(authenticate(`Bearer x${"a".repeat(9000)}`, verify)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses tokens for other audiences, other keys, and expired tokens", () => {
    const mcp = signSessionToken({ ...claims, aud: "kobe.mcp-proxy" }, KEY);
    const otherKey = signSessionToken({ ...claims, aud: "kobe.egress-proxy" }, "o".repeat(40));
    const expired = signSessionToken(
      { ...claims, aud: "kobe.egress-proxy", iat: now - 2000, exp: now - 1000 },
      KEY,
    );
    for (const token of [mcp, otherKey, expired, "not.a.token"]) {
      expect(authenticate(`Bearer ${token}`, verify)).toEqual({ ok: false, reason: "invalid" });
    }
  });
});
