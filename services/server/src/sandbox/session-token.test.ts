import { createHmac } from "node:crypto";
import { SESSION_TOKEN_AUDIENCES, sessionTokenClaimsSchema } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { KEYS } from "../testing/sandbox-fixtures.js";
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
const sign = (input: string, key: string) =>
  createHmac("sha256", key).update(input).digest("base64url");

const issued = issueSessionTokens(PRINCIPAL, KEYS, NOW);
const wire = issued.tokens["kobe.sandbox-wire"];

describe("session tokens", () => {
  it("issues one token per audience with the contract's claims", () => {
    expect(Object.keys(issued.tokens).sort()).toEqual([...SESSION_TOKEN_AUDIENCES].sort());
    for (const aud of SESSION_TOKEN_AUDIENCES) {
      const claims = verifySessionToken(issued.tokens[aud], aud, KEYS[aud], NOW_S);
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
      (aud) => verifySessionToken(issued.tokens[aud], aud, KEYS[aud], NOW_S).jti,
    );
    expect(new Set(jtis).size).toBe(4);
  });

  it("rejects a token presented to another audience, even with that audience's key", () => {
    expect(() => verifySessionToken(wire, "kobe.mcp-proxy", KEYS["kobe.mcp-proxy"], NOW_S)).toThrow(
      SessionTokenError,
    );
    // Same key, wrong audience claim: still refused.
    expect(() =>
      verifySessionToken(wire, "kobe.mcp-proxy", KEYS["kobe.sandbox-wire"], NOW_S),
    ).toThrow(/audience/);
  });

  it("pins HS256: alg none, other algorithms and extra headers are refused", () => {
    const [, payload] = wire.split(".") as [string, string, string];
    const key = KEYS["kobe.sandbox-wire"];
    const forge = (header: object, signature?: string) => {
      const input = `${b64(header)}.${payload}`;
      return `${input}.${signature ?? sign(input, key)}`;
    };
    for (const token of [
      forge({ alg: "none", typ: "JWT" }, "AA"),
      `${b64({ alg: "none", typ: "JWT" })}.${payload}.`,
      forge({ alg: "HS512", typ: "JWT" }),
      forge({ alg: "HS256" }),
      forge({ alg: "HS256", typ: "JWT", kid: "x" }),
      forge({ alg: "HS256", typ: "JWT", jku: "https://evil.example/keys" }),
      forge({ alg: "EdDSA", typ: "JWT" }),
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
    const key = KEYS["kobe.sandbox-wire"];
    expect(() => verifySessionToken(tampered, "kobe.sandbox-wire", key, NOW_S)).toThrow(
      /signature/,
    );
    expect(() => verifySessionToken(wire, "kobe.sandbox-wire", "x".repeat(40), NOW_S)).toThrow(
      /signature/,
    );
    expect(() =>
      verifySessionToken(wire, "kobe.sandbox-wire", key, NOW_S + SESSION_TOKEN_TTL_SECONDS),
    ).toThrow(/expired/);
    expect(() => verifySessionToken(wire, "kobe.sandbox-wire", key, NOW_S - 120)).toThrow(/future/);
  });

  it("refuses validly signed payloads that break the claims contract", () => {
    const key = KEYS["kobe.sandbox-wire"];
    const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ aud: "kobe.sandbox-wire", admin: true })}`;
    expect(() =>
      verifySessionToken(`${input}.${sign(input, key)}`, "kobe.sandbox-wire", key, NOW_S),
    ).toThrow(/contract/);
  });

  it("refuses garbage and oversized input", () => {
    const key = KEYS["kobe.sandbox-wire"];
    for (const token of ["", "a.b", "a.b.c.d", "a b.c.d", "x".repeat(5000)]) {
      expect(() => verifySessionToken(token, "kobe.sandbox-wire", key, NOW_S)).toThrow(
        SessionTokenError,
      );
    }
  });
});
