import type { SessionTokenClaims } from "@kobe/protocol";
import { verifySessionToken } from "@kobe/session-token";

/**
 * Sandbox authentication at the proxy (D27): `Authorization: Bearer <kobe.mcp-proxy session token>`,
 * verified with the MCP proxy's own key (HS256 pinned, exact header, audience, expiry; other
 * audiences' tokens fail the signature). This is a pre-filter that keeps junk away from the
 * server; the server verifies the same token again and checks liveness and membership.
 */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(header ?? "");
  return match?.[1];
}

export function verifySandboxToken(
  token: string | undefined,
  key: string,
  nowSeconds?: number,
): SessionTokenClaims | undefined {
  if (token === undefined) return undefined;
  try {
    return verifySessionToken(token, "kobe.mcp-proxy", key, nowSeconds);
  } catch {
    return undefined;
  }
}
