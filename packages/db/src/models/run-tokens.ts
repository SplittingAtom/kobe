import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { KobeDb, KobeTx } from "../client.js";
import { withTeam } from "../with-team.js";
import { ACTIVE_RUN_STATUSES, runTokens, runs, sandboxRunLeases } from "../schema/index.js";

/** What the server records when it mints a run token (the token itself is never stored). */
export interface RunTokenRecord {
  readonly teamId: string;
  readonly jti: string;
  readonly runId: string;
  readonly sandboxId: string;
  readonly expiresAt: Date;
}

/** Records a minted token, in the transaction that leases the run to the sandbox. */
export async function recordRunToken(tx: KobeTx, record: RunTokenRecord): Promise<void> {
  await tx.insert(runTokens).values({ ...record });
}

/** Revokes every live token of a run (run end), in the transaction that ends it. */
export async function revokeRunTokens(tx: KobeTx, teamId: string, runId: string): Promise<void> {
  await tx
    .update(runTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(runTokens.teamId, teamId), eq(runTokens.runId, runId), isNull(runTokens.revokedAt)),
    );
}

/** The claims a verified token carries that the stateful check compares with the record. */
export interface RunTokenSubject {
  readonly teamId: string;
  readonly jti: string;
  readonly runId: string;
  readonly sandboxId: string;
}

/**
 * The gateway's stateful check for a token whose MAC, shape and time already verified: the
 * recorded token is not revoked or expired, names this run and sandbox, and the run is still
 * active and leased to that sandbox (so a token also dies with a run ended by a path that
 * missed the revocation).
 */
export async function isRunTokenActive(
  db: KobeDb,
  subject: RunTokenSubject,
  now: Date = new Date(),
): Promise<boolean> {
  return withTeam(db, subject.teamId, async (tx) => {
    const rows = await tx
      .select({ jti: runTokens.jti })
      .from(runTokens)
      .innerJoin(runs, and(eq(runs.teamId, runTokens.teamId), eq(runs.id, runTokens.runId)))
      .innerJoin(
        sandboxRunLeases,
        and(
          eq(sandboxRunLeases.teamId, runTokens.teamId),
          eq(sandboxRunLeases.runId, runTokens.runId),
        ),
      )
      .where(
        and(
          eq(runTokens.teamId, subject.teamId),
          eq(runTokens.jti, subject.jti),
          eq(runTokens.runId, subject.runId),
          eq(runTokens.sandboxId, subject.sandboxId),
          isNull(runTokens.revokedAt),
          gt(runTokens.expiresAt, now),
          eq(sandboxRunLeases.sandboxId, subject.sandboxId),
          inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
}
