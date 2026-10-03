import { eq, teams, type KobeDb } from "@kobe/db";
import type { SandboxProvider } from "../sandbox/provider.js";
import { verifySessionToken } from "../sandbox/session-token.js";
import type { SessionKeys } from "../sandbox/config.js";
import type { SandboxLiveness, SessionTokenVerifier } from "./types.js";

/** Positive liveness answers are reused this long (each check is a Kubernetes API read). */
export const LIVENESS_CACHE_MS = 20_000;

/**
 * The wire's token verifier: KOBE-22's `verifySessionToken` with the `kobe.sandbox-wire` key only —
 * HS256 pinned, exact header (no `none`, `kid`, `jku`, embedded keys), audience must be exactly
 * `kobe.sandbox-wire`, `exp`/`iat` checked. Tokens for the model gateway, MCP or egress proxy have
 * other keys and fail the signature.
 */
export function sandboxWireVerifier(keys: SessionKeys): SessionTokenVerifier {
  const key = keys["kobe.sandbox-wire"];
  return (token) => verifySessionToken(token, "kobe.sandbox-wire", key);
}

/**
 * Liveness from the agent-sandbox claims (KOBE-22): the sandbox token's `sub` must still be the UID
 * of the (team, user) claim. Sandbox tokens have no Better Auth session; this plus the account and
 * membership checks (`principalAllowed`) is the "session still exists" check KOBE-13 asks of
 * verifiers. Only positive answers are cached, briefly; API errors throw (the upgrade is refused,
 * a running connection keeps going until the next check).
 */
export function providerLiveness(
  provider: Pick<SandboxProvider, "isLive">,
  db: KobeDb,
  cacheMs = LIVENESS_CACHE_MS,
): SandboxLiveness {
  const cache = new Map<string, number>();
  return {
    async isLive({ sandboxId, teamId, userId }) {
      const key = `${teamId}:${userId}:${sandboxId}`;
      const until = cache.get(key);
      if (until !== undefined && until > Date.now()) return true;
      cache.delete(key);
      const [team] = await db
        .select({ id: teams.id, slug: teams.slug })
        .from(teams)
        .where(eq(teams.id, teamId));
      if (!team) return false;
      const live = await provider.isLive(team, userId, sandboxId);
      if (live) {
        if (cache.size > 10_000) cache.clear();
        cache.set(key, Date.now() + cacheMs);
      }
      return live;
    },
  };
}
