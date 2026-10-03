import { eq, getMembership, users, type KobeDb } from "@kobe/db";
import type { SessionTokenClaims } from "@kobe/protocol";
import type { SandboxLiveness, SessionTokenVerifier } from "../sandbox-wire/types.js";

/**
 * Who is calling the workspace sync endpoints (KOBE-27): the same checks as the sandbox wire's
 * upgrade (KOBE-24) — a valid `kobe.sandbox-wire` token (HS256 pinned, audience exact, not
 * expired), the sandbox `sub` still live for (team, user), the account active and still a member.
 * Positive answers are cached briefly (each costs a Kubernetes read and two queries); a token's
 * expiry is always checked by `verify`.
 */
export interface SandboxCaller {
  readonly sandboxId: string;
  readonly teamId: string;
  readonly userId: string;
}

export type AuthResult =
  | { readonly ok: true; readonly caller: SandboxCaller }
  | { readonly ok: false; readonly reason: "no_token" | "invalid" | "not_live" | "not_allowed" };

export type SandboxAuthenticator = (authorization: string | undefined) => Promise<AuthResult>;

export const AUTH_CACHE_MS = 20_000;

export function createSandboxAuthenticator(options: {
  readonly db: KobeDb;
  readonly verify: SessionTokenVerifier;
  readonly liveness: SandboxLiveness;
  readonly cacheMs?: number;
  readonly now?: () => number;
}): SandboxAuthenticator {
  const { db, verify, liveness, cacheMs = AUTH_CACHE_MS, now = () => Date.now() } = options;
  const allowed = new Map<string, number>();

  const principalAllowed = async (c: SandboxCaller): Promise<boolean> => {
    const key = `${c.teamId}:${c.userId}:${c.sandboxId}`;
    const until = allowed.get(key);
    if (until !== undefined && until > now()) return true;
    allowed.delete(key);
    const [account] = await db
      .select({ deactivatedAt: users.deactivatedAt })
      .from(users)
      .where(eq(users.id, c.userId));
    if (!account || account.deactivatedAt !== null) return false;
    if ((await getMembership(db, c.teamId, c.userId)) === null) return false;
    if (allowed.size > 10_000) allowed.clear();
    allowed.set(key, now() + cacheMs);
    return true;
  };

  return async (authorization) => {
    const match = /^Bearer ([A-Za-z0-9._~+/=-]{1,4096})$/.exec(authorization ?? "");
    if (!match?.[1]) return { ok: false, reason: "no_token" };
    let claims: SessionTokenClaims;
    try {
      claims = verify(match[1]);
    } catch {
      return { ok: false, reason: "invalid" };
    }
    const caller = { sandboxId: claims.sub, teamId: claims.team_id, userId: claims.user_id };
    if (!(await liveness.isLive(caller))) return { ok: false, reason: "not_live" };
    if (!(await principalAllowed(caller))) return { ok: false, reason: "not_allowed" };
    return { ok: true, caller };
  };
}
