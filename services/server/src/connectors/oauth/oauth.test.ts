import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEnvelope } from "@kobe/db";
import { clientMetadataDocument, kobeOrigin, obtainClient } from "./client.js";
import { sameUrl, wellKnown, type AuthServerInfo } from "./discovery.js";
import type { OauthIo } from "./http.js";
import { challengeOf, newVerifier } from "./pkce.js";
import { openState, sealState, STATE_TTL_MS } from "./state.js";

const loaded = loadEnvelope({ KOBE_ENVELOPE_KEY: "e".repeat(48) });
if (!loaded) throw new Error("envelope not loaded");
const envelope = loaded;
const info: AuthServerInfo = {
  resource: "https://mcp.example.com/mcp",
  scopes: [],
  issuer: "https://auth.example.com",
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  registrationEndpoint: undefined,
  cimd: true,
  issParameterSupported: true,
  tokenAuthMethods: ["none"],
};
const io: OauthIo = {
  policy: {} as never,
  timeoutMs: 1000,
};

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    expect(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
  it("makes distinct 43-character verifiers", () => {
    const [a, b] = [newVerifier(), newVerifier()];
    expect(a).toHaveLength(43);
    expect(a).not.toBe(b);
  });
});

describe("client identity", () => {
  it("uses the metadata document URL as client_id over https when the server supports CIMD", async () => {
    const kobe = kobeOrigin("https://kobe.example.com/");
    expect(await obtainClient(io, info, kobe)).toEqual({
      clientId: "https://kobe.example.com/v1/oauth/client-metadata.json",
      clientSecret: undefined,
    });
    expect(clientMetadataDocument(kobe)).toMatchObject({
      client_id: kobe.clientMetadataUrl,
      redirect_uris: ["https://kobe.example.com/v1/connector-grants/oauth/callback"],
    });
  });
  it("needs registration when CIMD cannot be used", async () => {
    await expect(
      obtainClient(io, { ...info, cimd: false }, kobeOrigin("https://kobe.example.com")),
    ).rejects.toMatchObject({ code: "oauth_unsupported" });
    await expect(obtainClient(io, info, kobeOrigin("http://kobe.test"))).rejects.toMatchObject({
      code: "oauth_unsupported",
    });
  });
});

describe("discovery URLs", () => {
  it("inserts the well-known segment between host and path (RFC 8615)", () => {
    expect(wellKnown("https://h.example/a/mcp", "oauth-protected-resource")).toBe(
      "https://h.example/.well-known/oauth-protected-resource/a/mcp",
    );
    expect(wellKnown("https://h.example/", "oauth-authorization-server")).toBe(
      "https://h.example/.well-known/oauth-authorization-server",
    );
  });
  it("compares resources by origin and path", () => {
    expect(sameUrl("https://h.example/mcp/", "https://h.example/mcp")).toBe(true);
    expect(sameUrl("https://h.example/mcp", "https://evil.example/mcp")).toBe(false);
  });
});

describe("flow state", () => {
  const subject = { teamId: randomUUID(), userId: randomUUID(), connectorId: randomUUID() };
  const payload = {
    verifier: newVerifier(),
    resource: info.resource,
    issuer: info.issuer,
    issRequired: true,
    tokenEndpoint: info.tokenEndpoint,
    clientId: "c",
  };
  const now = new Date("2026-10-09T12:00:00Z");

  it("opens for its user and holds no readable verifier", () => {
    const state = sealState(envelope, subject, payload, now);
    expect(state).not.toContain(payload.verifier);
    expect(openState(envelope, state, subject.userId, now).payload.verifier).toBe(payload.verifier);
  });
  it.each([
    ["another user", (s: string) => [s, randomUUID()] as const],
    ["a tampered state", (s: string) => [`${s}A`, subject.userId] as const],
    [
      "a swapped connector",
      (s: string) => [s.replace(subject.connectorId, randomUUID()), subject.userId] as const,
    ],
    [
      "a swapped team",
      (s: string) => [s.replace(subject.teamId, randomUUID()), subject.userId] as const,
    ],
    ["garbage", () => ["nonsense", subject.userId] as const],
  ])("refuses %s", (_n, mutate) => {
    const [state, user] = mutate(sealState(envelope, subject, payload, now));
    expect(() => openState(envelope, state, user, now)).toThrow("invalid_state");
  });
  it("expires", () => {
    const state = sealState(envelope, subject, payload, now);
    const later = new Date(now.getTime() + STATE_TTL_MS + 1);
    expect(() => openState(envelope, state, subject.userId, later)).toThrow("invalid_state");
  });
});
