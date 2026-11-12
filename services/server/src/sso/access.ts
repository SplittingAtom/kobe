import {
  SYSTEM_ACTOR,
  eq,
  scanTeams,
  ssoAccessMappings,
  ssoProviders,
  teamMembers,
  withTeam,
  type AuditActor,
  type KobeDb,
  type KobeTx,
  type TeamRole,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { currentAuditContext, runWithAuditContext } from "../audit/context.js";
import { logger } from "../logger.js";
import {
  afterMemberRemoved,
  afterMemberRoleChanged,
  type AfterChangeDeps,
} from "../teams/after-change.js";
import {
  idpAddedVia,
  lockForChange,
  removeMemberInTx,
  setMemberRoleInTx,
  type MembershipError,
} from "../teams/members.js";
import { desiredTeamRoles, normalizeIdpValues, planTeam, type TeamRow } from "./access-plan.js";

/**
 * The access-mapping engine (KOBE-627, spec sso-oidc-scim §7, SSO2/SSO6/SSO10), shared by SSO
 * sign-in and SCIM. It turns the IdP values a person has (app-role values or group object ids)
 * into desired team memberships through the provider's mappings, then reconciles only the rows
 * that provider manages (`team_members.added_via = 'idp:<provider>'`):
 *
 * 1. per team, the highest mapped role wins;
 * 2. a desired team without a row gets a managed row; a managed row whose role differs is updated;
 *    a managed row no longer desired is removed through `teams/members.ts` (schedules pause, the
 *    usual side effects run), each team in its own `withTeam()` transaction;
 * 3. manual rows (and any row the provider doesn't own) are never changed or removed: a differing
 *    desire is recorded as `identity.sso.mapping_conflict` (`manual_row`);
 * 4. a removal or downgrade that would leave a team without an active team admin keeps the row and
 *    records `mapping_conflict` (`last_team_admin`); the next apply retries;
 * 5. no matched value means every managed row goes (manual rows and site roles stay);
 * 6. no mapping grants a site role (the role column is the `team_role` enum; checked again here).
 *
 * Every change is audited in the team's log with `via: "idp"` and the provider id.
 */

export interface IdpAccessInput {
  readonly providerId: string;
  readonly userId: string;
  /** The person's values from the ID token claim or their SCIM group memberships. */
  readonly values: readonly unknown[];
  /** Who is acting: defaults to the request's actor, else the system (SCIM jobs). */
  readonly actor?: AuditActor;
}

export type IdpAccessChange =
  | { readonly kind: "added"; readonly teamId: string; readonly role: TeamRole }
  | {
      readonly kind: "role_changed";
      readonly teamId: string;
      readonly from: TeamRole;
      readonly to: TeamRole;
    }
  | { readonly kind: "removed"; readonly teamId: string; readonly role: TeamRole };

export interface IdpAccessConflict {
  readonly teamId: string;
  readonly reason: "manual_row" | "last_team_admin";
}

export interface IdpAccessResult {
  readonly changes: readonly IdpAccessChange[];
  readonly conflicts: readonly IdpAccessConflict[];
  /**
   * Every team membership the person holds afterwards (managed or not). Sign-in refuses
   * `no_access` when this is empty and they hold no site role (§7 rule 5).
   */
  readonly memberships: readonly { readonly teamId: string; readonly role: TeamRole }[];
}

export class UnknownProviderError extends Error {
  override readonly name = "UnknownProviderError";
}

type Outcome =
  | { readonly change: IdpAccessChange | null; readonly role: TeamRole | null }
  | { readonly conflict: IdpAccessConflict["reason"]; readonly role: TeamRole | null };

/**
 * Applies the provider's mappings to one person (see the module comment). Commits per team; the
 * caller runs {@link followUpIdpAccess} afterwards (or uses {@link applyIdpAccessAndFollowUp}).
 */
export async function applyIdpAccess(db: KobeDb, input: IdpAccessInput): Promise<IdpAccessResult> {
  const values = normalizeIdpValues(input.values);
  const context = currentAuditContext();
  const actor = input.actor ?? context?.actor ?? SYSTEM_ACTOR;
  // Every event this apply causes (also those deep in teams/members.ts) names this actor; an agent
  // delegation of the surrounding request does not carry over.
  const audit = {
    actor,
    ip: actor.kind === "system" ? null : (context?.ip ?? null),
    userAgent: actor.kind === "system" ? null : (context?.userAgent ?? null),
  };
  return runWithAuditContext(audit, async () => {
    const [provider] = await db
      .select({ id: ssoProviders.id })
      .from(ssoProviders)
      .where(eq(ssoProviders.id, input.providerId));
    if (!provider) throw new UnknownProviderError("applyIdpAccess: unknown provider");
    const mappings = await db
      .select({
        claimValue: ssoAccessMappings.claimValue,
        teamId: ssoAccessMappings.teamId,
        role: ssoAccessMappings.role,
      })
      .from(ssoAccessMappings)
      .where(eq(ssoAccessMappings.providerId, provider.id));
    const desired = desiredTeamRoles(mappings, values);
    const tag = idpAddedVia(provider.id);

    // Where the person is a member now (each team read under its own RLS context).
    const current = await scanTeams(db, "applyIdpAccess", async (tx, team) => {
      const [row] = await tx
        .select({ role: teamMembers.role, addedVia: teamMembers.addedVia })
        .from(teamMembers)
        .where(eq(teamMembers.userId, input.userId));
      return row ? { teamId: team.id, ...row } : undefined;
    });
    const touched = new Set<string>([
      ...desired.keys(),
      ...current.filter((r) => r.addedVia === tag).map((r) => r.teamId),
    ]);
    const roles = new Map(current.map((r) => [r.teamId, r.role as TeamRole | null]));

    const changes: IdpAccessChange[] = [];
    const conflicts: IdpAccessConflict[] = [];
    for (const teamId of [...touched].sort()) {
      const outcome = await withTeam(db, teamId, (tx) =>
        reconcileTeam(tx, {
          teamId,
          userId: input.userId,
          providerId: provider.id,
          tag,
          desired: desired.get(teamId),
        }),
      );
      roles.set(teamId, outcome.role);
      if ("conflict" in outcome) conflicts.push({ teamId, reason: outcome.conflict });
      else if (outcome.change) changes.push(outcome.change);
    }
    const memberships = [...roles]
      .filter((e): e is [string, TeamRole] => e[1] !== null)
      .map(([teamId, role]) => ({ teamId, role }));
    return { changes, conflicts, memberships };
  });
}

/** One team, inside its transaction: re-read the row under lock and apply the plan. */
async function reconcileTeam(
  tx: KobeTx,
  p: {
    readonly teamId: string;
    readonly userId: string;
    readonly providerId: string;
    readonly tag: string;
    readonly desired: TeamRole | undefined;
  },
): Promise<Outcome> {
  // Same lock order as every membership change (admin rows, then the target): no deadlocks.
  const lock = await lockForChange(tx, p.teamId, p.userId);
  const row: TeamRow | null =
    lock.current === null ? null : { role: lock.current, addedVia: lock.addedVia };
  const plan = planTeam({ row, desired: p.desired, tag: p.tag });
  const via = { idp: p.providerId };
  switch (plan.kind) {
    case "none":
      return { change: null, role: row?.role ?? null };
    case "conflict":
      return conflict(tx, p, "manual_row", row?.role ?? null);
    case "add": {
      const added = await tx
        .insert(teamMembers)
        .values({ teamId: p.teamId, userId: p.userId, role: plan.role, addedVia: p.tag })
        .onConflictDoNothing()
        .returning({ role: teamMembers.role });
      // A row appeared since the lock (a concurrent accept): it stands; the next apply sees it.
      if (added.length === 0) return { change: null, role: null };
      await recordAudit(tx, {
        action: "identity.member.added",
        teamId: p.teamId,
        target: { userId: p.userId, role: plan.role, via: "idp", providerId: p.providerId },
      });
      return { change: { kind: "added", teamId: p.teamId, role: plan.role }, role: plan.role };
    }
    case "change": {
      const result = await setMemberRoleInTx(tx, p.teamId, p.userId, plan.to, { via });
      if (!result.ok) return refused(tx, p, result.error, plan.from);
      return {
        change: { kind: "role_changed", teamId: p.teamId, from: plan.from, to: plan.to },
        role: plan.to,
      };
    }
    case "remove": {
      const result = await removeMemberInTx(tx, p.teamId, p.userId, via);
      if (!result.ok) return refused(tx, p, result.error, plan.role);
      return { change: { kind: "removed", teamId: p.teamId, role: plan.role }, role: null };
    }
  }
}

async function refused(
  tx: KobeTx,
  p: { readonly teamId: string; readonly userId: string; readonly providerId: string },
  error: MembershipError,
  role: TeamRole,
): Promise<Outcome> {
  if (error === "last_team_admin") return conflict(tx, p, "last_team_admin", role);
  // Under the same lock the plan was made with, nothing else can refuse: a bug, not a conflict.
  throw new Error(`applyIdpAccess: membership change refused (${error})`);
}

async function conflict(
  tx: KobeTx,
  p: { readonly teamId: string; readonly userId: string; readonly providerId: string },
  reason: IdpAccessConflict["reason"],
  role: TeamRole | null,
): Promise<Outcome> {
  await recordAudit(tx, {
    action: "identity.sso.mapping_conflict",
    target: { providerId: p.providerId, teamId: p.teamId, userId: p.userId, reason },
  });
  return { conflict: reason, role };
}

/**
 * What follows the committed changes outside their transactions: scheduled runs cancelled,
 * sandboxes offboarded and mounts reconciled for removals; checkouts and mounts for role changes.
 * Never throws: a failure is logged and the sweeps finish it.
 */
export async function followUpIdpAccess(
  deps: AfterChangeDeps,
  userId: string,
  result: IdpAccessResult,
): Promise<void> {
  for (const change of result.changes) {
    try {
      if (change.kind === "removed") await afterMemberRemoved(deps, change.teamId, userId);
      else if (change.kind === "role_changed")
        await afterMemberRoleChanged(deps, change.teamId, userId);
    } catch (err) {
      logger.error(
        { err, team_id: change.teamId, change: change.kind },
        "follow-up after an identity provider membership change failed",
      );
    }
  }
}

/** {@link applyIdpAccess} then {@link followUpIdpAccess}: what sign-in and SCIM call. */
export async function applyIdpAccessAndFollowUp(
  deps: AfterChangeDeps,
  input: IdpAccessInput,
): Promise<IdpAccessResult> {
  const result = await applyIdpAccess(deps.database.db, input);
  await followUpIdpAccess(deps, input.userId, result);
  return result;
}
