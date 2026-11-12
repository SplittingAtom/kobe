import {
  and,
  eq,
  isNull,
  scimGroupMembers,
  scimGroups,
  scimTokens,
  siteRoles,
  ssoAccessMappings,
  ssoIdentities,
  users,
  type KobeDb,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import type { AfterChangeDeps } from "../teams/after-change.js";
import { applyIdpAccessAndFollowUp } from "./access.js";
import { desiredTeamRoles, normalizeIdpValues } from "./access-plan.js";
import type { SsoFailure, VerifiedIdentity } from "./claims.js";
import type { SsoProvider } from "./oidc-flow.js";

/**
 * Who a validated SSO identity signs in as (spec sso-oidc-scim §5.5, §6, §7; KOBE-628):
 *
 * - **linked** (`sso_identities` on provider + subject) → that user; deactivated → refused;
 * - **unlinked, a user has the token's address** → `link_required`, never linked on email (§6,
 *   the "nOAuth" takeover); SSO-5 builds the proof flow;
 * - **unlinked, new address** → a user only when JIT is on **and** the mappings give at least one
 *   team (no access, no account); the identity is linked `jit`.
 *
 * The mapping engine then applies the token's values at every sign-in; a person left with no team
 * and no site role is refused (`no_access`). A groups overage uses the person's SCIM group
 * memberships when the provider has a live SCIM token, else it is refused (`groups_overage`).
 */

export type SsoUserOutcome =
  | { readonly ok: true; readonly userId: string; readonly created: boolean }
  | { readonly ok: false; readonly failure: SsoFailure; readonly userId?: string };

const refuse = (failure: SsoFailure, userId?: string): SsoUserOutcome =>
  userId === undefined ? { ok: false, failure } : { ok: false, failure, userId };

async function linkedUser(db: KobeDb, providerId: string, subject: string) {
  const [row] = await db
    .select({ userId: ssoIdentities.userId, deactivatedAt: users.deactivatedAt })
    .from(ssoIdentities)
    .innerJoin(users, eq(users.id, ssoIdentities.userId))
    .where(and(eq(ssoIdentities.providerId, providerId), eq(ssoIdentities.subject, subject)));
  return row;
}

/** SCIM is on for the provider when it has a live (unrevoked) SCIM token (§7 overage). */
async function scimEnabled(db: KobeDb, providerId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: scimTokens.id })
    .from(scimTokens)
    .where(and(eq(scimTokens.providerId, providerId), isNull(scimTokens.revokedAt)))
    .limit(1);
  return row !== undefined;
}

/** The person's SCIM group object ids at this provider (the values a groups claim would carry). */
async function scimGroupValues(db: KobeDb, providerId: string, userId: string): Promise<string[]> {
  const rows = await db
    .select({ value: scimGroups.externalId })
    .from(scimGroupMembers)
    .innerJoin(scimGroups, eq(scimGroups.id, scimGroupMembers.groupId))
    .where(and(eq(scimGroups.providerId, providerId), eq(scimGroupMembers.userId, userId)));
  return rows.map((r) => r.value);
}

async function hasSiteRole(db: KobeDb, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: siteRoles.role })
    .from(siteRoles)
    .where(eq(siteRoles.userId, userId));
  return row !== undefined;
}

function pgCode(err: unknown): { code?: string; constraint?: string } {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") {
      return { code, constraint: String((e as { constraint?: unknown }).constraint ?? "") };
    }
    e = (e as { cause?: unknown }).cause;
  }
  return {};
}

/** Applies the values and refuses when the person is left with no team and no site role. */
async function applyAccess(
  deps: AfterChangeDeps,
  p: SsoProvider,
  userId: string,
  values: readonly string[],
): Promise<SsoUserOutcome | undefined> {
  const result = await applyIdpAccessAndFollowUp(deps, {
    providerId: p.id,
    userId,
    values,
    actor: { kind: "user", id: userId },
  });
  if (result.memberships.length === 0 && !(await hasSiteRole(deps.database.db, userId))) {
    return refuse("no_access", userId);
  }
  return undefined;
}

type NewUser =
  | { readonly kind: "created"; readonly userId: string }
  | { readonly kind: "email_taken" }
  | { readonly kind: "raced" };

async function createJitUser(
  db: KobeDb,
  p: SsoProvider,
  identity: VerifiedIdentity & { readonly email: string },
): Promise<NewUser> {
  try {
    return await db.transaction(async (tx): Promise<NewUser> => {
      const [user] = await tx
        .insert(users)
        .values({
          email: identity.email,
          name: identity.name ?? identity.email.split("@")[0] ?? identity.email,
          // The token's own evidence; Kobe never treats it as proof of identity (§6).
          emailVerified: identity.emailVerified,
        })
        .returning({ id: users.id });
      if (!user) throw new Error("user insert returned no row");
      await tx.insert(ssoIdentities).values({
        providerId: p.id,
        subject: identity.subject,
        userId: user.id,
        linkedVia: "jit",
        emailAtLink: identity.email,
        lastSignInAt: new Date(),
      });
      await recordAudit(tx, {
        action: "identity.sso.link.created",
        actor: { kind: "user", id: user.id },
        target: { providerId: p.id, userId: user.id, method: "jit" },
      });
      return { kind: "created", userId: user.id };
    });
  } catch (err) {
    const { code, constraint } = pgCode(err);
    if (code !== "23505") throw err;
    return constraint?.startsWith("users_") ? { kind: "email_taken" } : { kind: "raced" };
  }
}

export async function resolveSsoUser(
  deps: AfterChangeDeps,
  p: SsoProvider,
  identity: VerifiedIdentity,
): Promise<SsoUserOutcome> {
  const db = deps.database.db;
  let linked = await linkedUser(db, p.id, identity.subject);

  if (!linked) {
    if (identity.values === null) return refuse("groups_overage");
    if (identity.email !== null) {
      const [same] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, identity.email));
      if (same) return refuse("link_required", same.id);
    }
    if (!p.jitProvisioning) return refuse("no_access");
    const mappings = await db
      .select({
        claimValue: ssoAccessMappings.claimValue,
        teamId: ssoAccessMappings.teamId,
        role: ssoAccessMappings.role,
      })
      .from(ssoAccessMappings)
      .where(eq(ssoAccessMappings.providerId, p.id));
    if (desiredTeamRoles(mappings, normalizeIdpValues(identity.values)).size === 0) {
      return refuse("no_access");
    }
    if (identity.email === null) return refuse("email_missing");
    const created = await createJitUser(db, p, { ...identity, email: identity.email });
    if (created.kind === "email_taken") return refuse("link_required");
    if (created.kind === "created") {
      const refused = await applyAccess(deps, p, created.userId, identity.values);
      return refused ?? { ok: true, userId: created.userId, created: true };
    }
    // Another sign-in of the same identity created it first: continue as linked.
    linked = await linkedUser(db, p.id, identity.subject);
    if (!linked) return refuse("token_invalid");
  }

  if (linked.deactivatedAt !== null) return refuse("deactivated", linked.userId);
  let values = identity.values;
  if (values === null) {
    if (!(await scimEnabled(db, p.id))) return refuse("groups_overage", linked.userId);
    values = await scimGroupValues(db, p.id, linked.userId);
  }
  const refused = await applyAccess(deps, p, linked.userId, values);
  if (refused) return refused;
  await db
    .update(ssoIdentities)
    .set({ lastSignInAt: new Date() })
    .where(and(eq(ssoIdentities.providerId, p.id), eq(ssoIdentities.subject, identity.subject)));
  return { ok: true, userId: linked.userId, created: false };
}
