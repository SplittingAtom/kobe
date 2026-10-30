import { eq, sql, teams, withTeam, type KobeDb } from "@kobe/db";
import type { SandboxProvider } from "../sandbox/provider.js";
import { verifySessionToken } from "../sandbox/session-token.js";
import type { SessionVerifyKeySets } from "../sandbox/config.js";
import type { SandboxLiveness, SessionTokenVerifier } from "./types.js";

/** Positive liveness answers are reused this long (each check is a Kubernetes API read). */
export const LIVENESS_CACHE_MS = 20_000;

/**
 * The wire's token verifier: KOBE-22's `verifySessionToken` with the `kobe.sandbox-wire` public
 * key(s) only — EdDSA pinned (KOBE-513), exact header (no `none`, `jku`, embedded keys; `kid` only
 * picks one of these keys), audience must be exactly `kobe.sandbox-wire`, `exp`/`iat` checked.
 * Tokens for the model gateway, MCP or egress proxy have other keys and fail.
 */
export function sandboxWireVerifier(keys: SessionVerifyKeySets): SessionTokenVerifier {
  const wire = keys["kobe.sandbox-wire"];
  return (token) => verifySessionToken(token, "kobe.sandbox-wire", wire);
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
    async isLive({ sandboxId, teamId, userId, evalThreadId }) {
      const key = `${teamId}:${userId}:${sandboxId}:${evalThreadId ?? ""}`;
      const until = cache.get(key);
      if (until !== undefined && until > Date.now()) return true;
      cache.delete(key);
      const [team] = await db
        .select({ id: teams.id, slug: teams.slug })
        .from(teams)
        .where(eq(teams.id, teamId));
      if (!team) return false;
      // KOBE-325: an eval sandbox is live only while its execution runs (its eval row is live,
      // of this team and starter), on top of being its thread's claim.
      if (
        evalThreadId !== undefined &&
        !(await evalExecutionLive(db, teamId, userId, evalThreadId))
      )
        return false;
      const live =
        evalThreadId === undefined
          ? await provider.isLive(team, userId, sandboxId)
          : await provider.isLive(team, userId, sandboxId, evalThreadId);
      if (live) {
        if (cache.size > 10_000) cache.clear();
        cache.set(key, Date.now() + cacheMs);
      }
      return live;
    },
  };
}

/**
 * Whether an eval thread's execution is running (KOBE-325): the thread is an eval thread of that
 * member, its result row names it and is starting, running or collecting, and its eval run is open.
 */
export async function evalExecutionLive(
  db: KobeDb,
  teamId: string,
  userId: string,
  threadId: string,
): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    const res = await tx.execute(sql`
      SELECT 1 FROM threads t
        JOIN skill_eval_results x ON x.team_id = t.team_id AND x.thread_id = t.id
        JOIN skill_eval_runs r ON r.team_id = x.team_id AND r.id = x.eval_run_id
       WHERE t.team_id = ${teamId} AND t.id = ${threadId} AND t.skill_eval
         AND t.owner_user_id = ${userId} AND r.started_by = ${userId}
         AND x.state IN ('starting', 'running', 'collecting')
         AND r.status IN ('queued', 'running') AND r.cancel_requested_at IS NULL`);
    return res.rows.length > 0;
  });
}
