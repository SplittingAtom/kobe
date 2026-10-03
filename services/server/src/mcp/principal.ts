import { verifySessionToken } from "@kobe/session-token";
import { eq, getMembership, users, type KobeDb } from "@kobe/db";
import type { SandboxLiveness } from "../sandbox-wire/types.js";
import type { McpPrincipal } from "./decide.js";

/**
 * Who is calling the MCP proxy, re-established by the server on every request: the sandbox's
 * `kobe.mcp-proxy` session token (verified here with that audience's key: HS256 pinned, exact
 * header, `aud`, `exp`), the sandbox still live for (team, user) (KOBE-22 claim), the account
 * active and the user still a member of the team. The proxy's own check of the token is a
 * pre-filter; this one decides.
 */
export type McpAuthResult =
  | { readonly ok: true; readonly principal: McpPrincipal }
  | { readonly ok: false; readonly code: "unauthorized" | "not_live" | "not_allowed" };

export interface McpAuthDeps {
  readonly db: KobeDb;
  /** The `kobe.mcp-proxy` session-token key (never another audience's). */
  readonly sessionKey: string;
  readonly liveness: SandboxLiveness;
}

export async function authenticateSandbox(
  deps: McpAuthDeps,
  token: string | undefined,
): Promise<McpAuthResult> {
  if (!token) return { ok: false, code: "unauthorized" };
  let claims;
  try {
    claims = verifySessionToken(token, "kobe.mcp-proxy", deps.sessionKey);
  } catch {
    return { ok: false, code: "unauthorized" };
  }
  const principal: McpPrincipal = {
    sandboxId: claims.sub,
    teamId: claims.team_id,
    userId: claims.user_id,
  };
  if (!(await deps.liveness.isLive(principal))) return { ok: false, code: "not_live" };
  const [user] = await deps.db
    .select({ deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, principal.userId));
  if (!user || user.deactivatedAt !== null) return { ok: false, code: "not_allowed" };
  if ((await getMembership(deps.db, principal.teamId, principal.userId)) === null) {
    return { ok: false, code: "not_allowed" };
  }
  return { ok: true, principal };
}
