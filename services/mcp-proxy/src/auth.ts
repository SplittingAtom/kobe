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

/**
 * A token that is genuine (signature, header, audience, claims) but past `exp`. Checked by
 * verifying it again at its own `iat`, so only expiry can be what failed. Used for one thing: a
 * request on an MCP session (`Mcp-Session-Id`) with such a token gets a 404, which MCP clients
 * answer by opening a new session (re-reading their credentials) and retrying once.
 */
export function isExpiredSandboxToken(
  token: string | undefined,
  key: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (token === undefined || verifySandboxToken(token, key, nowSeconds) !== undefined) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    const iat: unknown = payload?.iat;
    return typeof iat === "number" && verifySandboxToken(token, key, iat) !== undefined;
  } catch {
    return false;
  }
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
