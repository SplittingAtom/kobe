import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { KobeDb } from "@kobe/db";
import { issueSessionTokens, signSessionToken } from "../sandbox/session-token.js";
import { providerLiveness, sandboxWireVerifier } from "./provider-auth.js";

const keys = {
  "kobe.sandbox-wire": "w".repeat(40),
  "kobe.model-gateway": "m".repeat(40),
  "kobe.mcp-proxy": "p".repeat(40),
  "kobe.egress-proxy": "e".repeat(40),
} as const;
const principal = {
  sandboxId: "00000000-0000-4000-8000-000000000001",
  teamId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
};

describe("sandbox wire verifier (KOBE-22 tokens)", () => {
  const verify = sandboxWireVerifier(keys);
  const { tokens } = issueSessionTokens(principal, keys);

  it("accepts the sandbox-wire token and yields its claims", () => {
    expect(verify(tokens["kobe.sandbox-wire"])).toMatchObject({
      sub: principal.sandboxId,
      team_id: principal.teamId,
      user_id: principal.userId,
      aud: "kobe.sandbox-wire",
    });
  });

  it("refuses the other audiences' tokens", () => {
    for (const aud of ["kobe.model-gateway", "kobe.mcp-proxy", "kobe.egress-proxy"] as const) {
      expect(() => verify(tokens[aud])).toThrow();
    }
  });

  it("refuses a wrong-audience token signed with the wire key, alg none and tampering", () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "kobe-server" as const,
      sub: principal.sandboxId,
      team_id: principal.teamId,
      user_id: principal.userId,
      iat: now,
      exp: now + 600,
      jti: "j".repeat(20),
    };
    expect(() =>
      verify(signSessionToken({ ...claims, aud: "kobe.mcp-proxy" }, keys["kobe.sandbox-wire"])),
    ).toThrow();
    const payload = Buffer.from(JSON.stringify({ ...claims, aud: "kobe.sandbox-wire" })).toString(
      "base64url",
    );
    const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url");
    expect(() => verify(`${none}.${payload}.`)).toThrow();
    const hs512 = Buffer.from('{"alg":"HS512","typ":"JWT"}').toString("base64url");
    const mac = createHmac("sha512", keys["kobe.sandbox-wire"])
      .update(`${hs512}.${payload}`)
      .digest("base64url");
    expect(() => verify(`${hs512}.${payload}.${mac}`)).toThrow();
    const [h, , s] = tokens["kobe.sandbox-wire"].split(".");
    expect(() => verify(`${h}.${payload}x.${s}`)).toThrow();
  });
});

describe("provider liveness", () => {
  function db(teamRows: { id: string; slug: string }[]): KobeDb {
    const chain = { from: () => chain, where: () => Promise.resolve(teamRows) };
    return { select: () => chain } as unknown as KobeDb;
  }

  it("asks the provider with the team's slug and caches positive answers only", async () => {
    const isLive = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const live = providerLiveness({ isLive }, db([{ id: principal.teamId, slug: "fin" }]), 60_000);
    expect(await live.isLive(principal)).toBe(true);
    expect(await live.isLive(principal)).toBe(true);
    expect(isLive).toHaveBeenCalledTimes(1);
    expect(isLive).toHaveBeenCalledWith(
      { id: principal.teamId, slug: "fin" },
      principal.userId,
      principal.sandboxId,
    );
    const other = { ...principal, sandboxId: "00000000-0000-4000-8000-000000000009" };
    expect(await live.isLive(other)).toBe(false);
    expect(await live.isLive(other)).toBe(false);
    expect(isLive).toHaveBeenCalledTimes(3);
  });

  it("is false for an unknown team", async () => {
    const isLive = vi.fn();
    expect(await providerLiveness({ isLive }, db([])).isLive(principal)).toBe(false);
    expect(isLive).not.toHaveBeenCalled();
  });
});
