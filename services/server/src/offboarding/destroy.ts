import { SYSTEM_ACTOR, eq, sql, teams, withTeam } from "@kobe/db";
import { currentAuditContext } from "../audit/context.js";
import { recordAudit } from "../audit/record.js";
import {
  RETAIN_DAYS,
  type Departed,
  type OffboardTrigger,
  type OffboardingContext,
  type TeamIdentity,
} from "./types.js";

export type OffboardOutcome = "offboarded" | "already_offboarded" | "no_sandbox";

export async function findTeam(
  ctx: OffboardingContext,
  teamId: string,
): Promise<TeamIdentity | undefined> {
  const [team] = await ctx.db
    .select({ id: teams.id, slug: teams.slug })
    .from(teams)
    .where(eq(teams.id, teamId));
  return team;
}

const toIso = (value: unknown): string => new Date(value as string | Date).toISOString();

/**
 * Destroys a departed member's sandbox in one team at once and keeps the workspace volume for
 * {@link RETAIN_DAYS} days (D12, KOBE-28).
 *
 * Kubernetes first (the provider detaches the volume from its Sandbox, then deletes the claim; a
 * failure throws and nothing is recorded, so a retry or the sweep finishes it), then one team
 * transaction: the `sandboxes` row becomes `destroyed` with `retain_until` (the row is kept, not
 * deleted: the model-gateway principal check treats a missing row as live, KOBE-40), its
 * connection row is closed and `sandbox.offboarded` is audited. The sandbox row is the record of
 * the retention: a returning member's wake (reinstate.ts) and the sweep (purge.ts) read it.
 */
export async function offboardSandbox(
  ctx: OffboardingContext,
  target: Departed,
  trigger: OffboardTrigger,
): Promise<OffboardOutcome> {
  const team = await findTeam(ctx, target.teamId);
  if (!team) return "no_sandbox";
  const { userId, teamId } = target;
  const provider = ctx.provider();
  const destroyed = provider
    ? await provider.destroySandbox(team, userId, { retainVolume: true })
    : {};
  return withTeam(ctx.db, teamId, async (tx) => {
    const current = await tx.execute<{
      state: string;
      pvc: string | null;
      sandbox_id: string | null;
    }>(sql`
      SELECT state, pvc, sandbox_id FROM sandboxes
       WHERE team_id = ${teamId} AND user_id = ${userId} FOR UPDATE`);
    const row = current.rows[0];
    if (row?.state === "destroyed") return "already_offboarded";
    const workspace = await tx.execute(sql`
      SELECT 1 FROM workspace_sync WHERE team_id = ${teamId} AND user_id = ${userId}`);
    if (!row && !destroyed.sandboxId && workspace.rowCount === 0) return "no_sandbox";
    const pvc = destroyed.pvc ?? row?.pvc ?? null;
    const sandboxId = destroyed.sandboxId ?? row?.sandbox_id ?? null;
    const saved = await tx.execute<{ retain_until: string | Date }>(sql`
      INSERT INTO sandboxes (team_id, user_id, sandbox_id, state, pvc, retain_until, state_changed_at)
      VALUES (${teamId}, ${userId}, ${sandboxId}, 'destroyed', ${pvc},
              now() + make_interval(days => ${RETAIN_DAYS}), now())
      ON CONFLICT (team_id, user_id) DO UPDATE
        SET state = 'destroyed', sandbox_id = EXCLUDED.sandbox_id, pvc = EXCLUDED.pvc,
            retain_until = EXCLUDED.retain_until, state_changed_at = now()
      RETURNING retain_until`);
    await tx.execute(sql`
      UPDATE sandbox_connections SET closed_at = now()
       WHERE team_id = ${teamId} AND user_id = ${userId} AND closed_at IS NULL`);
    await recordAudit(tx, {
      action: "sandbox.offboarded",
      actor: currentAuditContext()?.actor ?? ctx.actor?.() ?? SYSTEM_ACTOR,
      teamId,
      target: {
        userId,
        ...(sandboxId ? { sandboxId } : {}),
        trigger,
        volumeKept: pvc !== null,
        retainUntil: toIso(saved.rows[0]?.retain_until),
      },
    });
    return "offboarded";
  });
}

/** Every team in which the user still has a sandbox that is not offboarded yet. */
export async function liveSandboxTeams(ctx: OffboardingContext, userId: string): Promise<string[]> {
  const all = await ctx.db.select({ id: teams.id }).from(teams);
  const found: string[] = [];
  for (const team of all) {
    const rows = await withTeam(ctx.db, team.id, (tx) =>
      tx.execute(sql`
        SELECT 1 FROM sandboxes
         WHERE team_id = ${team.id} AND user_id = ${userId} AND state <> 'destroyed'`),
    );
    if ((rows.rowCount ?? 0) > 0) found.push(team.id);
  }
  return found;
}

/** Sandboxes of a team not yet offboarded (team removal). */
export async function liveSandboxUsers(ctx: OffboardingContext, teamId: string): Promise<string[]> {
  const rows = await withTeam(ctx.db, teamId, (tx) =>
    tx.execute<{ user_id: string }>(sql`
      SELECT user_id FROM sandboxes WHERE team_id = ${teamId} AND state <> 'destroyed'`),
  );
  return rows.rows.map((r) => r.user_id);
}
