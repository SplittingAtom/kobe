import type { SessionTokenClaims } from "@kobe/protocol";
import { SessionTokenError, verifySessionToken } from "@kobe/session-token";

/**
 * Sandbox authentication to the egress proxy (spec D28, D13): the sandbox's `kobe.egress-proxy`
 * session token in `Proxy-Authorization`, as either
 *
 * - `Basic base64(<user>:<token>)` — what `HTTPS_PROXY=http://<user>:<token>@egress-proxy…` makes
 *   curl, pip, npm, git and Python send. `<user>` is free; when it is a thread id (UUID) it is a
 *   **hint** used only to attribute a blocked attempt to one of the user's own active runs.
 * - `Bearer <token>`.
 *
 * The token carries team, user and sandbox; nothing in the request can name another team.
 */
export interface SandboxIdentity {
  readonly sandboxId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly threadHint: string | undefined;
  readonly tokenId: string;
}

export type AuthResult =
  | { readonly ok: true; readonly identity: SandboxIdentity }
  | { readonly ok: false; readonly reason: "missing" | "malformed" | "invalid" };

const MAX_HEADER = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TokenVerifier = (token: string) => SessionTokenClaims;

/** Verifier bound to the proxy's own key (KOBE_SESSION_KEY_EGRESS_PROXY): HS256, exact header. */
export function egressTokenVerifier(key: string): TokenVerifier {
  return (token) => verifySessionToken(token, "kobe.egress-proxy", key);
}

function credentials(header: string): { user: string | undefined; token: string } | undefined {
  const space = header.indexOf(" ");
  if (space < 0) return undefined;
  const scheme = header.slice(0, space).toLowerCase();
  const value = header.slice(space + 1).trim();
  if (scheme === "bearer") return value ? { user: undefined, token: value } : undefined;
  if (scheme !== "basic" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return undefined;
  const token = decoded.slice(colon + 1);
  return token ? { user: decoded.slice(0, colon), token } : undefined;
}

export function authenticate(
  header: string | string[] | undefined,
  verify: TokenVerifier,
): AuthResult {
  if (header === undefined || header === "") return { ok: false, reason: "missing" };
  if (Array.isArray(header) || header.length > MAX_HEADER)
    return { ok: false, reason: "malformed" };
  const creds = credentials(header);
  if (!creds) return { ok: false, reason: "malformed" };
  let claims: SessionTokenClaims;
  try {
    claims = verify(creds.token);
  } catch (err) {
    if (err instanceof SessionTokenError) return { ok: false, reason: "invalid" };
    throw err;
  }
  const hint =
    creds.user !== undefined && UUID.test(creds.user) ? creds.user.toLowerCase() : undefined;
  return {
    ok: true,
    identity: {
      sandboxId: claims.sub,
      teamId: claims.team_id,
      userId: claims.user_id,
      threadHint: hint,
      tokenId: claims.jti,
    },
  };
}
