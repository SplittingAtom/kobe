import {
  accounts,
  and,
  asc,
  eq,
  gt,
  inArray,
  ne,
  passkeys,
  sessions,
  sessionSsoContexts,
  siteRoles,
  sql,
  ssoIdentities,
  ssoLinkExpectations,
  ssoProviders,
  users,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import type { VerifiedIdentity } from "./claims.js";
import type { LinkIntent } from "./link-intent.js";

/**
 * Account linking (spec sso-oidc-scim §6, SSO4, SSO9, SSO10; KOBE-630). Email is never proof:
 * an unlinked identity links to an existing Kobe user only through
 *
 * - **local proof**: the person signs in locally as that user after the SSO sign-in left a link
 *   intent (`linkByLocalProof`), or
 * - **an admin-expected link**: a site admin named the provider for the user beforehand; the next
 *   sign-in whose address is verified, equals the user's and lies in the provider's
 *   `allowed_email_domains` links once (`linkExpected`).
 *
 * Unlinking (`unlinkIdentity`) ends the user's sessions made through that provider and is refused
 * when the link is the user's only way to sign in. Every link, unlink and expectation is audited.
 * The setup Owner and site-role holders can't be the target of an expected link (SSO10, review
 * M3): they link by their own local proof, and keep local sign-in. A local proof links only after
 * the signed-in user confirms it (review M1).
 */

export const LINK_EXPECTATION_TTL_MS = 14 * 24 * 3_600_000;

const domainOf = (email: string): string => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

const isUniqueViolation = (err: unknown): boolean => {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e; depth++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
};

/** The provider's verified domains admit this address (an expected link needs one, §6). */
export function domainAllowed(allowedEmailDomains: readonly string[], email: string): boolean {
  const domain = domainOf(email);
  return allowedEmailDomains.some((d) => d.toLowerCase() === domain);
}

/**
 * The setup Owner or any site-role holder (Owner, Admin): never the target of an expected link
 * (SSO10; review M3). An expected link would hand the Kobe account to whoever controls the IdP
 * account (helpdesk roles can reset it), and IdP data never grants site roles; these people link
 * by their own local proof.
 */
async function isProtectedTarget(db: KobeDb | KobeTx, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: siteRoles.role, setupOwner: users.setupOwner })
    .from(users)
    .leftJoin(siteRoles, eq(siteRoles.userId, users.id))
    .where(eq(users.id, userId));
  return row !== undefined && (row.setupOwner || row.role !== null);
}

// ---------------------------------------------------------------------------------------------
// Admin-expected links

export type ExpectationFailure =
  | "user_not_found"
  | "provider_not_found"
  | "deactivated"
  | "protected_user"
  | "already_linked"
  | "domain_not_verified";

export interface ExpectationView {
  readonly providerId: string;
  readonly providerName: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * Records (or renews) an expected link for the user at the provider, valid 14 days. Refused for an
 * unknown or deactivated user, the setup Owner or a site-role holder, a user already linked at the provider, and
 * when the user's address is not in the provider's verified domains (`allowed_email_domains`).
 */
export async function expectLink(
  db: KobeDb,
  input: { readonly providerId: string; readonly userId: string; readonly actorId: string },
): Promise<
  { ok: true; expectation: ExpectationView } | { ok: false; failure: ExpectationFailure }
> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ email: users.email, deactivatedAt: users.deactivatedAt })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update");
    if (!user) return { ok: false, failure: "user_not_found" };
    const [provider] = await tx
      .select({ name: ssoProviders.displayName, domains: ssoProviders.allowedEmailDomains })
      .from(ssoProviders)
      .where(eq(ssoProviders.id, input.providerId));
    if (!provider) return { ok: false, failure: "provider_not_found" };
    if (user.deactivatedAt !== null) return { ok: false, failure: "deactivated" };
    if (await isProtectedTarget(tx, input.userId)) {
      return { ok: false, failure: "protected_user" };
    }
    const [linked] = await tx
      .select({ subject: ssoIdentities.subject })
      .from(ssoIdentities)
      .where(
        and(eq(ssoIdentities.providerId, input.providerId), eq(ssoIdentities.userId, input.userId)),
      );
    if (linked) return { ok: false, failure: "already_linked" };
    if (!domainAllowed(provider.domains, user.email)) {
      return { ok: false, failure: "domain_not_verified" };
    }
    const expiresAt = new Date(Date.now() + LINK_EXPECTATION_TTL_MS);
    const [row] = await tx
      .insert(ssoLinkExpectations)
      .values({
        providerId: input.providerId,
        userId: input.userId,
        createdBy: input.actorId,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [ssoLinkExpectations.providerId, ssoLinkExpectations.userId],
        set: { createdBy: input.actorId, createdAt: sql`now()`, expiresAt },
      })
      .returning({ createdAt: ssoLinkExpectations.createdAt });
    if (!row) throw new Error("link expectation insert returned no row");
    await recordAudit(tx, {
      action: "identity.sso.link_expected",
      target: { providerId: input.providerId, userId: input.userId },
    });
    return {
      ok: true,
      expectation: {
        providerId: input.providerId,
        providerName: provider.name,
        createdAt: row.createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    };
  });
}

/** Withdraws an unused expectation; false when there was none. */
export async function withdrawExpectation(
  db: KobeDb,
  input: { readonly providerId: string; readonly userId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const gone = await tx
      .delete(ssoLinkExpectations)
      .where(
        and(
          eq(ssoLinkExpectations.providerId, input.providerId),
          eq(ssoLinkExpectations.userId, input.userId),
        ),
      )
      .returning({ userId: ssoLinkExpectations.userId });
    if (gone.length === 0) return false;
    await recordAudit(tx, { action: "identity.sso.link_expectation.withdrawn", target: input });
    return true;
  });
}

/**
 * At an SSO sign-in of an unlinked identity whose address belongs to `userId`: links it when an
 * unexpired expectation exists **and** the address is verified **and** its domain is one of the
 * provider's verified domains (§6). The expectation is consumed in the same transaction as the
 * link (single use). False, with nothing changed, otherwise (including a race on either key).
 */
export async function linkExpected(
  db: KobeDb,
  provider: { readonly id: string; readonly allowedEmailDomains: readonly string[] },
  identity: VerifiedIdentity & { readonly email: string },
  userId: string,
): Promise<boolean> {
  if (!identity.emailVerified || !domainAllowed(provider.allowedEmailDomains, identity.email)) {
    return false;
  }
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .select({ email: users.email, deactivatedAt: users.deactivatedAt })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      if (!user || user.deactivatedAt !== null || user.email !== identity.email) return false;
      if (await isProtectedTarget(tx, userId)) return false;
      const used = await tx
        .delete(ssoLinkExpectations)
        .where(
          and(
            eq(ssoLinkExpectations.providerId, provider.id),
            eq(ssoLinkExpectations.userId, userId),
            gt(ssoLinkExpectations.expiresAt, sql`now()`),
          ),
        )
        .returning({ userId: ssoLinkExpectations.userId });
      if (used.length === 0) return false;
      await tx.insert(ssoIdentities).values({
        providerId: provider.id,
        subject: identity.subject,
        userId,
        linkedVia: "admin_expected",
        emailAtLink: identity.email,
      });
      await recordAudit(tx, {
        action: "identity.sso.link.created",
        actor: { kind: "user", id: userId },
        target: { providerId: provider.id, userId, method: "admin_expected" },
      });
      return true;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Local proof

export type LocalProofOutcome =
  "linked" | "ready" | "other_user" | "provider_unavailable" | "already_linked" | "identity_taken";

/** What a local proof links: the intent's identity (provider, subject, address). */
export type LocalProofIdentity = Pick<LinkIntent, "providerId" | "subject" | "email">;

/**
 * The local-proof checks: the user's address equals the intent's, the provider is still enabled,
 * and neither key is linked yet. With `commit: false` (after the local sign-in) it only answers
 * `ready`; the link is written (`local_proof`, audited) only with `commit: true`, after the
 * signed-in user confirmed it (review M1). Any other outcome changes nothing.
 */
export async function linkByLocalProof(
  db: KobeDb,
  intent: LocalProofIdentity,
  userId: string,
  { commit }: { readonly commit: boolean },
): Promise<LocalProofOutcome> {
  try {
    return await db.transaction(async (tx): Promise<LocalProofOutcome> => {
      const [user] = await tx
        .select({ email: users.email, deactivatedAt: users.deactivatedAt })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      if (!user || user.deactivatedAt !== null || user.email !== intent.email) {
        return "other_user";
      }
      const [provider] = await tx
        .select({ enabled: ssoProviders.enabled })
        .from(ssoProviders)
        .where(eq(ssoProviders.id, intent.providerId));
      if (!provider?.enabled) return "provider_unavailable";
      const existing = await tx
        .select({ userId: ssoIdentities.userId, subject: ssoIdentities.subject })
        .from(ssoIdentities)
        .where(eq(ssoIdentities.providerId, intent.providerId));
      if (existing.some((r) => r.userId === userId)) return "already_linked";
      if (existing.some((r) => r.subject === intent.subject)) return "identity_taken";
      if (!commit) return "ready";
      await tx.insert(ssoIdentities).values({
        providerId: intent.providerId,
        subject: intent.subject,
        userId,
        linkedVia: "local_proof",
        emailAtLink: intent.email,
      });
      // A local proof supersedes an expectation for the same provider.
      await tx
        .delete(ssoLinkExpectations)
        .where(
          and(
            eq(ssoLinkExpectations.providerId, intent.providerId),
            eq(ssoLinkExpectations.userId, userId),
          ),
        );
      await recordAudit(tx, {
        action: "identity.sso.link.created",
        actor: { kind: "user", id: userId },
        target: { providerId: intent.providerId, userId, method: "local_proof" },
      });
      return "linked";
    });
  } catch (err) {
    if (isUniqueViolation(err)) return "identity_taken";
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Listing and unlinking

export interface LinkView {
  readonly providerId: string;
  readonly providerName: string;
  readonly linkedVia: string;
  readonly emailAtLink: string | null;
  readonly linkedAt: string;
  readonly lastSignInAt: string | null;
}

export async function listLinks(db: KobeDb, userId: string): Promise<LinkView[]> {
  const rows = await db
    .select({
      providerId: ssoIdentities.providerId,
      providerName: ssoProviders.displayName,
      linkedVia: ssoIdentities.linkedVia,
      emailAtLink: ssoIdentities.emailAtLink,
      linkedAt: ssoIdentities.linkedAt,
      lastSignInAt: ssoIdentities.lastSignInAt,
    })
    .from(ssoIdentities)
    .innerJoin(ssoProviders, eq(ssoProviders.id, ssoIdentities.providerId))
    .where(eq(ssoIdentities.userId, userId))
    .orderBy(asc(ssoProviders.displayName));
  return rows.map((r) => ({
    ...r,
    linkedAt: r.linkedAt.toISOString(),
    lastSignInAt: r.lastSignInAt?.toISOString() ?? null,
  }));
}

export async function listExpectations(db: KobeDb, userId: string): Promise<ExpectationView[]> {
  const rows = await db
    .select({
      providerId: ssoLinkExpectations.providerId,
      providerName: ssoProviders.displayName,
      createdAt: ssoLinkExpectations.createdAt,
      expiresAt: ssoLinkExpectations.expiresAt,
    })
    .from(ssoLinkExpectations)
    .innerJoin(ssoProviders, eq(ssoProviders.id, ssoLinkExpectations.providerId))
    .where(
      and(eq(ssoLinkExpectations.userId, userId), gt(ssoLinkExpectations.expiresAt, sql`now()`)),
    )
    .orderBy(asc(ssoProviders.displayName));
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }));
}

/**
 * The user can still sign in without this provider: a password, a passkey, or a link to another
 * **enabled** provider (review L2). Locks the credential and passkey rows it relies on, so a
 * concurrent removal waits for this transaction (the user row is locked by the caller).
 */
export async function hasOtherSignIn(
  tx: KobeTx,
  userId: string,
  exceptProviderId: string | null,
  exceptPasskeyId: string | null = null,
): Promise<boolean> {
  const passwords = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
    .for("update");
  if (passwords.length > 0) return true;
  const keys = await tx
    .select({ id: passkeys.id })
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .for("update");
  if (keys.some((k) => k.id !== exceptPasskeyId)) return true;
  const others = await tx
    .select({ providerId: ssoIdentities.providerId })
    .from(ssoIdentities)
    .innerJoin(ssoProviders, eq(ssoProviders.id, ssoIdentities.providerId))
    .where(
      and(
        eq(ssoIdentities.userId, userId),
        eq(ssoProviders.enabled, true),
        exceptProviderId === null ? undefined : ne(ssoIdentities.providerId, exceptProviderId),
      ),
    );
  return others.length > 0;
}

/**
 * Whether removing the passkey would leave the user no way to sign in (review L2), checked on the
 * locked user row; `/passkey/delete-passkey` is refused then.
 */
export async function passkeyIsLastSignIn(
  db: KobeDb,
  userId: string,
  passkeyId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    return !(await hasOtherSignIn(tx, userId, null, passkeyId));
  });
}

export type UnlinkOutcome =
  | { readonly ok: true; readonly sessionsEnded: number }
  | { readonly ok: false; readonly failure: "not_linked" | "last_sign_in_method" };

/**
 * Removes the user's link to the provider and ends their sessions made through it (§6, §9), in one
 * transaction on the locked user row. Refused when it is the user's only way to sign in (no
 * password, no passkey, no other link): a site admin deactivates such an account instead.
 */
export async function unlinkIdentity(
  db: KobeDb,
  input: { readonly userId: string; readonly providerId: string; readonly by: "user" | "admin" },
): Promise<UnlinkOutcome> {
  return db.transaction(async (tx): Promise<UnlinkOutcome> => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("update");
    const [link] = await tx
      .select({ subject: ssoIdentities.subject })
      .from(ssoIdentities)
      .where(
        and(eq(ssoIdentities.userId, input.userId), eq(ssoIdentities.providerId, input.providerId)),
      );
    if (!link) return { ok: false, failure: "not_linked" };
    if (!(await hasOtherSignIn(tx, input.userId, input.providerId))) {
      return { ok: false, failure: "last_sign_in_method" };
    }
    await tx
      .delete(ssoIdentities)
      .where(
        and(eq(ssoIdentities.userId, input.userId), eq(ssoIdentities.providerId, input.providerId)),
      );
    const ids = tx
      .select({ id: sessionSsoContexts.sessionId })
      .from(sessionSsoContexts)
      .innerJoin(sessions, eq(sessions.id, sessionSsoContexts.sessionId))
      .where(
        and(eq(sessionSsoContexts.providerId, input.providerId), eq(sessions.userId, input.userId)),
      );
    const gone = await tx
      .delete(sessions)
      .where(inArray(sessions.id, ids))
      .returning({ id: sessions.id });
    await recordAudit(tx, {
      action: "identity.sso.link.removed",
      target: {
        providerId: input.providerId,
        userId: input.userId,
        by: input.by,
        sessionsEnded: gone.length,
      },
    });
    return { ok: true, sessionsEnded: gone.length };
  });
}
