import type { SessionTokenClaims } from "@kobe/protocol";
import {
  SessionTokenError,
  verifySessionToken,
  verifySiteEgressToken,
  type SiteEgressClaims,
  type SiteEgressPurpose,
} from "@kobe/session-token";

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
 *
 * The server's own site jobs (the catalog's git mirror, KOBE-343) send a **site egress token**
 * instead (`Bearer`, CONNECT only): it names a purpose, no team, user or sandbox, and is allowed
 * only hosts in the site egress ceiling. Plain-HTTP requests never accept one.
 */
export interface SandboxIdentity {
  readonly sandboxId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly threadHint: string | undefined;
  readonly tokenId: string;
  /** Token expiry (ms since the epoch): tunnels opened with it close then. */
  readonly expiresAt: number;
  /**
   * Set for the server's site job (KOBE-343): then `teamId` and `userId` are empty and never
   * consulted, `sandboxId` is `site:<purpose>` (its connection limit), and only the ceiling applies.
   */
  readonly site?: SiteEgressPurpose;
}

export type AuthResult =
  | { readonly ok: true; readonly identity: SandboxIdentity }
  | { readonly ok: false; readonly reason: "missing" | "malformed" | "invalid" };

const MAX_HEADER = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TokenVerifier = (token: string) => SessionTokenClaims;
export type SiteTokenVerifier = (token: string) => SiteEgressClaims;

/** Verifier bound to the proxy's own key (KOBE_SESSION_KEY_EGRESS_PROXY): HS256, exact header. */
export function egressTokenVerifier(key: string): TokenVerifier {
  return (token) => verifySessionToken(token, "kobe.egress-proxy", key);
}

/** Site egress tokens, verified with the same key (a different audience and exact claims). */
export function siteTokenVerifier(key: string): SiteTokenVerifier {
  return (token) => verifySiteEgressToken(token, key);
}

function siteIdentity(token: string, verifySite: SiteTokenVerifier): AuthResult {
  try {
    const claims = verifySite(token);
    return {
      ok: true,
      identity: {
        sandboxId: `site:${claims.sub}`,
        teamId: "",
        userId: "",
        threadHint: undefined,
        tokenId: claims.jti,
        expiresAt: claims.exp * 1000,
        site: claims.sub,
      },
    };
  } catch (err) {
    if (err instanceof SessionTokenError) return { ok: false, reason: "invalid" };
    throw err;
  }
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
  verifySite?: SiteTokenVerifier,
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
    if (!(err instanceof SessionTokenError)) throw err;
    // A site token comes only as a bearer token (never Basic: no tool ever sends one).
    return verifySite && creds.user === undefined
      ? siteIdentity(creds.token, verifySite)
      : { ok: false, reason: "invalid" };
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
      expiresAt: claims.exp * 1000,
    },
  };
}
