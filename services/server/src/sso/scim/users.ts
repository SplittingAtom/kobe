import {
  accounts,
  and,
  asc,
  eq,
  inArray,
  pgErrorOf,
  sessions,
  sessionSsoContexts,
  siteRoles,
  sql,
  ssoIdentities,
  users,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { deactivateUser, deactivatedVia, reactivateUser } from "../../users/deactivation.js";
import type { UserLifecycle } from "../../users/lifecycle.js";
import type { UserFilter } from "./filter.js";
import type { ScimType } from "./schemas.js";
import {
  addressFor,
  isAddress,
  nameFrom,
  type UserChanges,
  type UserResourceInput,
} from "./user-input.js";

/**
 * SCIM Users of one provider (KOBE-631, spec sso-oidc-scim §10, SSO8/SSO9/SSO10). A SCIM User is a
 * Kobe user linked to the provider in `sso_identities` (`subject` = `externalId` = the Entra
 * object id); the SCIM `id` is the Kobe user id. A provider sees only its own linked users. Kobe
 * never deletes users and never links on email: a create for an address that belongs to someone
 * else is `409 uniqueness`. SCIM-created users have no local credential (SSO9). Deactivation goes
 * through `users/deactivation.ts` (the Site console's path), and never touches the Owner, a site
 * Admin or the setup Owner (SSO8, SSO10).
 */
export interface ScimProvider {
  readonly id: string;
  readonly kind: "entra" | "oidc";
  /** The tenant's verified domains (`allowed_email_domains`). */
  readonly allowedEmailDomains: readonly string[];
}

/**
 * Whether a SCIM-given address counts as verified (review finding 1): only an Entra `userName`
 * (the UPN, which only a tenant admin can set) in one of the provider's verified domains. A work
 * email, a generic provider's userName, or another domain stays unverified, so it never matches a
 * team invitation.
 */
export function scimAddressVerified(
  provider: ScimProvider,
  userName: string,
  address: string,
): boolean {
  if (provider.kind !== "entra" || !isAddress(userName)) return false;
  if (userName.toLowerCase() !== address) return false;
  return provider.allowedEmailDomains.includes(address.slice(address.lastIndexOf("@") + 1));
}

export interface ScimContext {
  readonly db: KobeDb;
  readonly lifecycle: UserLifecycle;
  readonly provider: ScimProvider;
  readonly credentialId: string;
}

export interface ScimUserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly deactivatedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly externalId: string;
  readonly userName: string;
}

export type ScimFailure = {
  readonly ok: false;
  readonly status: 400 | 403 | 404 | 409;
  readonly scimType?: ScimType;
  readonly detail: string;
};
export type ScimOutcome<T> = { readonly ok: true; readonly value: T } | ScimFailure;

const failure = (
  status: ScimFailure["status"],
  detail: string,
  scimType?: ScimType,
): ScimFailure => ({ ok: false, status, detail, ...(scimType ? { scimType } : {}) });

const NOT_FOUND = failure(404, "No such User for this provider.");
const PROTECTED = failure(
  403,
  "Kobe never deactivates the Owner, a site Admin or the setup Owner through SCIM. A site admin decides in the Kobe Site console (People → Users).",
);
const EMAIL_TAKEN = failure(
  409,
  "A Kobe account with this address already exists and is not linked to this provider. Kobe never links accounts on email: a site admin can expect an SSO link for it (Site console → Users), or remove the user from provisioning.",
  "uniqueness",
);
const EXTERNAL_ID_IMMUTABLE = failure(
  400,
  "externalId can't change once set: it is the identity Kobe signs this person in as. Remove the user from provisioning and add the new identity instead.",
  "mutability",
);
const REACTIVATION_REFUSED = failure(
  403,
  "This user was deactivated by a site admin in Kobe, so SCIM can't reactivate them. A site admin reactivates them in the Kobe Site console (People → Users).",
);
const NO_ADDRESS = failure(
  400,
  "Kobe needs an email address: give userName as an address (the UPN) or a work email.",
  "invalidValue",
);

const COLUMNS = {
  id: users.id,
  email: users.email,
  name: users.name,
  deactivatedAt: users.deactivatedAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
  externalId: ssoIdentities.subject,
  userName: sql<string>`coalesce(${ssoIdentities.scimUserName}, ${users.email})`,
};

const userNameOf = sql`lower(coalesce(${ssoIdentities.scimUserName}, ${users.email}))`;

function whereFilter(providerId: string, filter: UserFilter | null): ReturnType<typeof and> {
  const own = eq(ssoIdentities.providerId, providerId);
  if (!filter) return own;
  switch (filter.attribute) {
    case "userName":
      return and(own, sql`${userNameOf} = lower(${filter.value})`);
    case "externalId":
      return and(own, eq(ssoIdentities.subject, filter.value));
    case "id":
      return /^[0-9a-f-]{36}$/i.test(filter.value)
        ? and(own, eq(users.id, filter.value.toLowerCase()))
        : sql`false`;
  }
}

/** One page of the provider's Users matching `filter`, and how many match in all. */
export async function listScimUsers(
  db: KobeDb,
  providerId: string,
  filter: UserFilter | null,
  startIndex: number,
  count: number,
): Promise<{ readonly total: number; readonly rows: readonly ScimUserRow[] }> {
  const where = whereFilter(providerId, filter);
  const [total] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ssoIdentities)
    .innerJoin(users, eq(users.id, ssoIdentities.userId))
    .where(where);
  const rows =
    count === 0
      ? []
      : await db
          .select(COLUMNS)
          .from(ssoIdentities)
          .innerJoin(users, eq(users.id, ssoIdentities.userId))
          .where(where)
          .orderBy(asc(users.createdAt), asc(users.id))
          .limit(count)
          .offset(startIndex - 1);
  return { total: total?.n ?? 0, rows };
}

async function readUser(
  db: KobeDb | KobeTx,
  providerId: string,
  userId: string,
  lock = false,
): Promise<ScimUserRow | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return undefined;
  const q = db
    .select(COLUMNS)
    .from(ssoIdentities)
    .innerJoin(users, eq(users.id, ssoIdentities.userId))
    .where(and(eq(ssoIdentities.providerId, providerId), eq(ssoIdentities.userId, userId)));
  const [row] = await (lock ? q.for("update") : q);
  return row;
}

export function getScimUser(
  db: KobeDb,
  providerId: string,
  userId: string,
): Promise<ScimUserRow | undefined> {
  return readUser(db, providerId, userId);
}

/** Postgres unique violations → SCIM `409 uniqueness` on the attribute that clashed. */
function uniquenessOf(err: unknown): ScimFailure | undefined {
  const pg = pgErrorOf(err);
  if (pg?.code !== "23505") return undefined;
  switch (pg.constraint) {
    case "users_email_unique":
      return EMAIL_TAKEN;
    case "sso_identities_scim_user_name":
      return failure(409, "Another User of this provider has this userName.", "uniqueness");
    default:
      return failure(409, "Another User of this provider has this externalId.", "uniqueness");
  }
}

/** Entra object ids are GUIDs; Kobe keys the identity on them (lowercase). */
function externalIdFor(provider: ScimProvider, raw: string | undefined): ScimOutcome<string> {
  if (raw === undefined) {
    return failure(
      400,
      "externalId is required: map the Entra objectId to externalId in the provisioning attribute mappings.",
      "invalidValue",
    );
  }
  if (provider.kind === "entra") {
    const id = raw.toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      return failure(400, "externalId must be the Entra object id (a GUID).", "invalidValue");
    }
    return { ok: true, value: id };
  }
  return { ok: true, value: raw };
}

/**
 * Creates a User (POST): a Kobe user with no credential account (SSO9), linked to the provider
 * (`linked_via: scim`). It has no team access until a mapping gives it some (SSO-8 or sign-in).
 */
export async function createScimUser(
  ctx: ScimContext,
  input: UserResourceInput,
): Promise<ScimOutcome<ScimUserRow>> {
  const externalId = externalIdFor(ctx.provider, input.externalId);
  if (!externalId.ok) return externalId;
  const email = addressFor(input.userName, input.email);
  if (!email) return NO_ADDRESS;
  const name = nameFrom(input) ?? input.userName;
  try {
    const userId = await ctx.db.transaction(async (tx) => {
      const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (taken) return EMAIL_TAKEN;
      const now = new Date();
      const [user] = await tx
        .insert(users)
        .values({
          email,
          name,
          emailVerified: scimAddressVerified(ctx.provider, input.userName, email),
          deactivatedAt: input.active === false ? now : null,
          deactivatedVia: input.active === false ? scimVia(ctx.provider) : null,
        })
        .returning({ id: users.id });
      if (!user) throw new Error("user insert returned no row");
      await tx.insert(ssoIdentities).values({
        providerId: ctx.provider.id,
        subject: externalId.value,
        userId: user.id,
        linkedVia: "scim",
        emailAtLink: email,
        scimUserName: input.userName,
      });
      const target = { providerId: ctx.provider.id, userId: user.id };
      await recordAudit(tx, {
        action: "identity.sso.link.created",
        target: { ...target, method: "scim" },
      });
      await recordAudit(tx, {
        action: "identity.scim.user.created",
        target: { ...target, credentialId: ctx.credentialId },
      });
      return user.id;
    });
    if (typeof userId !== "string") return userId;
    const row = await readUser(ctx.db, ctx.provider.id, userId);
    return row ? { ok: true, value: row } : NOT_FOUND;
  } catch (err) {
    const clash = uniquenessOf(err);
    if (clash) return clash;
    throw err;
  }
}

/**
 * The Owner, a site Admin, or the Owner the setup flow created (even after a transfer): SCIM never
 * changes whether they are active (SSO8, SSO10).
 */
async function isProtected(db: KobeDb | KobeTx, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: siteRoles.role, setupOwner: users.setupOwner })
    .from(users)
    .leftJoin(siteRoles, eq(siteRoles.userId, users.id))
    .where(eq(users.id, userId));
  // `users.setup_owner` is durable (set at setup, backfilled by 0212): no audit row needed.
  return row !== undefined && (row.role !== null || row.setupOwner);
}

const scimVia = (provider: ScimProvider) => `scim:${provider.id}` as const;

/**
 * SCIM reactivates only users its own provider deactivated (SSO11): a user a site admin
 * deactivated stays deactivated (403), and the attempt is audited.
 */
async function refuseReactivation(ctx: ScimContext, userId: string): Promise<ScimFailure> {
  await ctx.db.transaction((tx) =>
    recordAudit(tx, {
      action: "identity.scim.reactivation_refused",
      target: { providerId: ctx.provider.id, userId, credentialId: ctx.credentialId },
    }),
  );
  return REACTIVATION_REFUSED;
}

async function hasLocalCredential(tx: KobeTx, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")));
  return row !== undefined;
}

/**
 * A refused deactivation of a protected user (§10, SSO8): their sign-in sessions made through this
 * provider end (local sessions stay: the break-glass path), and the request is audited.
 */
async function refuseDeactivation(ctx: ScimContext, userId: string): Promise<ScimFailure> {
  await ctx.db.transaction(async (tx) => {
    const ids = await tx
      .select({ id: sessionSsoContexts.sessionId })
      .from(sessionSsoContexts)
      .innerJoin(sessions, eq(sessions.id, sessionSsoContexts.sessionId))
      .where(and(eq(sessionSsoContexts.providerId, ctx.provider.id), eq(sessions.userId, userId)));
    if (ids.length > 0) {
      await tx.delete(sessions).where(
        inArray(
          sessions.id,
          ids.map((r) => r.id),
        ),
      );
    }
    await recordAudit(tx, {
      action: "identity.scim.deactivation_refused",
      target: { providerId: ctx.provider.id, userId, credentialId: ctx.credentialId },
    });
  });
  return PROTECTED;
}

/**
 * Applies `active` through the Site console's path: `deactivateUser` (sessions and verifications
 * deleted in the same transaction, egress told, invitations revoked) then the lifecycle hooks
 * (sandboxes, connector grants, schedules); `reactivateUser` the other way.
 */
async function applyActive(ctx: ScimContext, userId: string, active: boolean): Promise<void> {
  const target = { providerId: ctx.provider.id, userId, credentialId: ctx.credentialId };
  if (active) {
    const did = await reactivateUser(ctx.db, userId, {
      inTx: async (tx, changed) => {
        if (changed) await recordAudit(tx, { action: "identity.scim.user.reactivated", target });
      },
    });
    if (did) await ctx.lifecycle.emit("reactivated", userId);
    return;
  }
  const did = await deactivateUser(ctx.db, userId, {
    via: scimVia(ctx.provider),
    inTx: async (tx, changed) => {
      if (changed) await recordAudit(tx, { action: "identity.scim.user.deactivated", target });
    },
  });
  if (did) await ctx.lifecycle.emit("deactivated", userId);
}

/**
 * Updates a User from a PATCH (only the attributes named) or a PUT (the whole resource). The
 * activation guard runs before anything is written: a request that would deactivate (or
 * reactivate) a protected user changes nothing and is refused 403.
 */
export async function updateScimUser(
  ctx: ScimContext,
  userId: string,
  changes: UserChanges,
  mode: "patch" | "put",
): Promise<ScimOutcome<ScimUserRow>> {
  const current = await readUser(ctx.db, ctx.provider.id, userId);
  if (!current) return NOT_FOUND;
  const wantsActive = changes.active;
  if (wantsActive !== undefined && wantsActive === (current.deactivatedAt !== null)) {
    if (await isProtected(ctx.db, userId)) {
      return wantsActive ? PROTECTED : refuseDeactivation(ctx, userId);
    }
    if (wantsActive && (await deactivatedVia(ctx.db, userId)) !== scimVia(ctx.provider)) {
      return refuseReactivation(ctx, userId);
    }
  }
  try {
    const outcome = await ctx.db.transaction(async (tx) => {
      const row = await readUser(tx, ctx.provider.id, userId, true);
      if (!row) return NOT_FOUND;
      // externalId is the identity's key (the subject Kobe signs this person in as): set at
      // creation, never moved to another directory object (review finding 2).
      if (changes.externalId !== undefined) {
        const next = externalIdFor(ctx.provider, changes.externalId);
        if (!next.ok) return next;
        if (next.value !== row.externalId) return EXTERNAL_ID_IMMUTABLE;
      }
      const userName = changes.userName ?? row.userName;
      const name = nameFrom(changes, mode === "patch") ?? row.name;
      // The sign-in address follows the directory only for users without a local password:
      // otherwise the IdP could point a local (break-glass) account's reset mail elsewhere.
      let email = row.email;
      if (changes.userName !== undefined || changes.email !== undefined) {
        const next = addressFor(userName, changes.email === undefined ? row.email : changes.email);
        // Never a site-role holder or the setup Owner either (SSO10), credential or not.
        const mayReaddress =
          next !== undefined &&
          next !== row.email &&
          !(await hasLocalCredential(tx, userId)) &&
          !(await isProtected(tx, userId));
        if (mayReaddress) {
          const [taken] = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, next));
          if (taken) return EMAIL_TAKEN;
          email = next;
        }
      }
      const identityChanged = userName !== row.userName;
      const userChanged = email !== row.email || name !== row.name;
      if (identityChanged) {
        await tx
          .update(ssoIdentities)
          .set({ scimUserName: userName })
          .where(
            and(eq(ssoIdentities.providerId, ctx.provider.id), eq(ssoIdentities.userId, userId)),
          );
      }
      if (userChanged) {
        await tx
          .update(users)
          .set({
            email,
            name,
            ...(email !== row.email
              ? { emailVerified: scimAddressVerified(ctx.provider, userName, email) }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));
      }
      if (identityChanged || userChanged) {
        await recordAudit(tx, {
          action: "identity.scim.user.updated",
          target: { providerId: ctx.provider.id, userId, credentialId: ctx.credentialId },
        });
      }
      return { ok: true, value: row } as const;
    });
    if (!outcome.ok) return outcome;
  } catch (err) {
    const clash = uniquenessOf(err);
    if (clash) return clash;
    throw err;
  }
  if (wantsActive !== undefined) await applyActive(ctx, userId, wantsActive);
  const row = await readUser(ctx.db, ctx.provider.id, userId);
  return row ? { ok: true, value: row } : NOT_FOUND;
}

/**
 * DELETE (§10): Kobe never deletes users. The user is deactivated (as `active: false`) and the
 * identity unlinked, so the provider no longer sees it (a later GET is 404). Refused for protected
 * users.
 */
export async function deleteScimUser(ctx: ScimContext, userId: string): Promise<ScimOutcome<null>> {
  const current = await readUser(ctx.db, ctx.provider.id, userId);
  if (!current) return NOT_FOUND;
  if (await isProtected(ctx.db, userId)) return refuseDeactivation(ctx, userId);
  const target = { providerId: ctx.provider.id, userId };
  const did = await deactivateUser(ctx.db, userId, {
    via: scimVia(ctx.provider),
    inTx: async (tx, changed) => {
      await tx
        .delete(ssoIdentities)
        .where(
          and(eq(ssoIdentities.providerId, ctx.provider.id), eq(ssoIdentities.userId, userId)),
        );
      if (changed) {
        await recordAudit(tx, {
          action: "identity.scim.user.deactivated",
          target: { ...target, credentialId: ctx.credentialId },
        });
      }
      await recordAudit(tx, {
        action: "identity.sso.link.removed",
        target: { ...target, by: "scim" },
      });
    },
  });
  if (did) await ctx.lifecycle.emit("deactivated", userId);
  return { ok: true, value: null };
}
