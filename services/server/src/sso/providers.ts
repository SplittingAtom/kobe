import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  Envelope,
  and,
  asc,
  eq,
  inArray,
  sessions,
  sessionSsoContexts,
  sql,
  ssoIdentities,
  ssoProviders,
  SYSTEM_ACTOR,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import type { MfaRule } from "./schemas.js";
import type { SsoSettings } from "./settings.js";

/**
 * The OIDC providers (spec sso-oidc-scim §4; KOBE-626). A console provider's client secret is sealed
 * with the site envelope (KOBE-107) bound to the provider (`kind: "sso_client_secret"`,
 * `recordId: <id>`), like connector credentials; a Helm provider's stays in its Kubernetes Secret
 * (`auth.sso.providers[].clientSecretSecret`) and only this process's memory. No view, audit row or
 * log line ever carries a secret: views say only whether one is set.
 */

/** A site-wide record has no team: the envelope binds to the nil team id. */
const SITE_TEAM = "00000000-0000-0000-0000-000000000000";

export function clientSecretContext(providerId: string) {
  return { teamId: SITE_TEAM, kind: "sso_client_secret", recordId: providerId } as const;
}

export interface ProviderSettings {
  readonly displayName: string;
  readonly issuer: string;
  readonly tenantId: string | null;
  readonly clientId: string;
  readonly subjectClaim: "oid" | "sub";
  readonly accessClaim: "roles" | "groups";
  readonly mfaRule: MfaRule;
  readonly allowedEmailDomains: readonly string[];
  readonly jitProvisioning: boolean;
  readonly maxSessionHours: number | null;
}

export interface NewProvider extends ProviderSettings {
  readonly slug: string;
  readonly kind: "entra" | "oidc";
  readonly clientSecret: string;
}

export interface ProviderPatch extends Partial<ProviderSettings> {
  /** Absent: the stored secret is kept. */
  readonly clientSecret?: string;
  readonly enabled?: boolean;
}

/** What the console sees: never the secret, only whether one is set. */
export interface ProviderView extends ProviderSettings {
  readonly id: string;
  readonly slug: string;
  readonly kind: "entra" | "oidc";
  readonly enabled: boolean;
  readonly managedBy: "console" | "helm";
  /** `set`: sealed (console) or mounted (Helm); `missing`: the Helm Secret was not mounted. */
  readonly clientSecret: "set" | "missing";
  /** Paste into the app registration (Entra: Authentication → Web → Redirect URIs). */
  readonly redirectUri: string;
  readonly linkedIdentities: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type Row = typeof ssoProviders.$inferSelect;

const COLUMNS = {
  id: ssoProviders.id,
  slug: ssoProviders.slug,
  displayName: ssoProviders.displayName,
  kind: ssoProviders.kind,
  issuer: ssoProviders.issuer,
  tenantId: ssoProviders.tenantId,
  clientId: ssoProviders.clientId,
  subjectClaim: ssoProviders.subjectClaim,
  accessClaim: ssoProviders.accessClaim,
  mfaRule: ssoProviders.mfaRule,
  allowedEmailDomains: ssoProviders.allowedEmailDomains,
  jitProvisioning: ssoProviders.jitProvisioning,
  enabled: ssoProviders.enabled,
  maxSessionHours: ssoProviders.maxSessionHours,
  managedBy: ssoProviders.managedBy,
  hasSecret: sql<boolean>`${ssoProviders.clientSecretSealed} IS NOT NULL`,
  createdAt: ssoProviders.createdAt,
  updatedAt: ssoProviders.updatedAt,
  linkedIdentities: sql<number>`(SELECT count(*)::int FROM ${ssoIdentities} WHERE ${ssoIdentities.providerId} = ${ssoProviders.id})`,
};

type Selected = {
  [K in keyof typeof COLUMNS]: (typeof COLUMNS)[K] extends { _: { data: infer D } } ? D : never;
};

export function redirectUriFor(publicUrl: string, slug: string): string {
  return `${new URL(publicUrl).origin}/api/auth/sso/callback/${slug}`;
}

function viewOf(r: Selected, publicUrl: string, settings: SsoSettings): ProviderView {
  const secretSet = r.managedBy === "helm" ? settings.helmSecrets.has(r.slug) : r.hasSecret;
  return {
    id: r.id,
    slug: r.slug,
    displayName: r.displayName,
    kind: r.kind,
    issuer: r.issuer,
    tenantId: r.tenantId,
    clientId: r.clientId,
    subjectClaim: r.subjectClaim,
    accessClaim: r.accessClaim,
    mfaRule: r.mfaRule as MfaRule,
    allowedEmailDomains: r.allowedEmailDomains,
    jitProvisioning: r.jitProvisioning,
    maxSessionHours: r.maxSessionHours,
    enabled: r.enabled,
    managedBy: r.managedBy,
    clientSecret: secretSet ? "set" : "missing",
    redirectUri: redirectUriFor(publicUrl, r.slug),
    linkedIdentities: Number(r.linkedIdentities),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export interface ProviderStore {
  readonly db: KobeDb;
  readonly publicUrl: string;
  readonly settings: SsoSettings;
  /** Unset: console providers cannot be created (their secret could not be sealed). */
  readonly envelope: Envelope | undefined;
}

export async function listProviders(s: ProviderStore): Promise<ProviderView[]> {
  const rows = await s.db.select(COLUMNS).from(ssoProviders).orderBy(asc(ssoProviders.slug));
  return rows.map((r) => viewOf(r as Selected, s.publicUrl, s.settings));
}

export async function getProvider(
  s: ProviderStore,
  id: string,
  db: KobeDb | KobeTx = s.db,
): Promise<ProviderView | undefined> {
  const [row] = await db.select(COLUMNS).from(ssoProviders).where(eq(ssoProviders.id, id));
  return row ? viewOf(row as Selected, s.publicUrl, s.settings) : undefined;
}

function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export type CreateOutcome =
  | { readonly ok: true; readonly provider: ProviderView }
  | { readonly ok: false; readonly failure: "slug_taken" | "credentials_unavailable" };

export async function createProvider(
  s: ProviderStore,
  input: NewProvider,
  userId: string,
): Promise<CreateOutcome> {
  if (!s.envelope) return { ok: false, failure: "credentials_unavailable" };
  const envelope = s.envelope;
  const id = randomUUID();
  const sealed = envelope.seal(input.clientSecret, clientSecretContext(id));
  try {
    return await s.db.transaction(async (tx): Promise<CreateOutcome> => {
      await tx.insert(ssoProviders).values({
        id,
        slug: input.slug,
        displayName: input.displayName,
        kind: input.kind,
        issuer: input.issuer,
        tenantId: input.tenantId,
        clientId: input.clientId,
        clientSecretSealed: sealed,
        clientSecretKeyId: Envelope.keyIdOf(sealed),
        subjectClaim: input.subjectClaim,
        accessClaim: input.accessClaim,
        mfaRule: input.mfaRule,
        allowedEmailDomains: [...input.allowedEmailDomains],
        jitProvisioning: input.jitProvisioning,
        maxSessionHours: input.maxSessionHours,
        managedBy: "console",
        createdBy: userId,
      });
      await recordAudit(tx, {
        action: "identity.sso.provider.created",
        target: { providerId: id, slug: input.slug, kind: input.kind },
      });
      const provider = await getProvider(s, id, tx);
      if (!provider) throw new Error("sso provider insert returned no row");
      return { ok: true, provider };
    });
  } catch (error) {
    if (pgCode(error) === "23505") return { ok: false, failure: "slug_taken" };
    throw error;
  }
}

/** Deletes every session signed in through the provider (§9: disabled, deleted or unlinked). */
async function endProviderSessions(tx: KobeTx, providerId: string): Promise<number> {
  const ids = tx
    .select({ id: sessionSsoContexts.sessionId })
    .from(sessionSsoContexts)
    .where(eq(sessionSsoContexts.providerId, providerId));
  const gone = await tx
    .delete(sessions)
    .where(inArray(sessions.id, ids))
    .returning({ id: sessions.id });
  return gone.length;
}

/**
 * With the kill switch off (`auth.sso.enabled: false`), deletes every session signed in through
 * any provider (review finding 6); run at start-up. Local sessions stay. Returns how many ended.
 */
export async function endSsoSessionsWhenOff(db: KobeDb, settings: SsoSettings): Promise<number> {
  if (settings.enabled) return 0;
  const ids = db.select({ id: sessionSsoContexts.sessionId }).from(sessionSsoContexts);
  const gone = await db
    .delete(sessions)
    .where(inArray(sessions.id, ids))
    .returning({ id: sessions.id });
  return gone.length;
}

export type ChangeFailure =
  "not_found" | "managed_by_helm" | "credentials_unavailable" | "identity_settings_locked";

/**
 * The settings that decide which IdP account an identity row means: the issuer (tenant) and the
 * subject claim. While any identity is linked they never change (review finding 5), or the same
 * `sso_identities.subject` would name another person.
 */
const IDENTITY_KEYS = ["issuer", "tenantId", "subjectClaim"] as const;

async function hasIdentities(tx: KobeTx, providerId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: ssoIdentities.providerId })
    .from(ssoIdentities)
    .where(eq(ssoIdentities.providerId, providerId))
    .limit(1);
  return row !== undefined;
}
export type UpdateOutcome =
  | { readonly ok: true; readonly provider: ProviderView }
  | { readonly ok: false; readonly failure: ChangeFailure };

/** The stored row of a provider, locked for a change. */
async function lockRow(tx: KobeTx, id: string): Promise<Row | undefined> {
  const [row] = await tx.select().from(ssoProviders).where(eq(ssoProviders.id, id)).for("update");
  return row;
}

/** Equal values, whatever the key order (jsonb returns object keys in its own order). */
function same(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}

function settingsChanged(row: Row, patch: ProviderPatch): boolean {
  const keys = [
    "displayName",
    "issuer",
    "tenantId",
    "clientId",
    "subjectClaim",
    "accessClaim",
    "mfaRule",
    "allowedEmailDomains",
    "jitProvisioning",
    "maxSessionHours",
  ] as const;
  return keys.some((k) => patch[k] !== undefined && !same(patch[k], row[k]));
}

/** Edits a console provider (a Helm provider is changed in the chart's values only). */
export async function updateProvider(
  s: ProviderStore,
  id: string,
  patch: ProviderPatch,
): Promise<UpdateOutcome> {
  if (patch.clientSecret !== undefined && !s.envelope) {
    return { ok: false, failure: "credentials_unavailable" };
  }
  return s.db.transaction(async (tx): Promise<UpdateOutcome> => {
    const row = await lockRow(tx, id);
    if (!row) return { ok: false, failure: "not_found" };
    if (row.managedBy === "helm") return { ok: false, failure: "managed_by_helm" };
    const identityMoves = IDENTITY_KEYS.some(
      (k) => patch[k] !== undefined && !same(patch[k], row[k]),
    );
    if (identityMoves && (await hasIdentities(tx, id))) {
      return { ok: false, failure: "identity_settings_locked" };
    }
    const changed = settingsChanged(row, patch);
    const sealed =
      patch.clientSecret !== undefined && s.envelope
        ? s.envelope.seal(patch.clientSecret, clientSecretContext(id))
        : undefined;
    const toggled = patch.enabled !== undefined && patch.enabled !== row.enabled;
    if (changed || sealed !== undefined || toggled) {
      const { clientSecret: _secret, allowedEmailDomains, ...plain } = patch;
      await tx
        .update(ssoProviders)
        .set({
          ...plain,
          ...(allowedEmailDomains ? { allowedEmailDomains: [...allowedEmailDomains] } : {}),
          ...(sealed !== undefined
            ? { clientSecretSealed: sealed, clientSecretKeyId: Envelope.keyIdOf(sealed) }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(ssoProviders.id, id));
    }
    const target = { providerId: id, slug: row.slug };
    if (changed || sealed !== undefined) {
      await recordAudit(tx, { action: "identity.sso.provider.updated", target });
    }
    if (toggled) {
      if (patch.enabled === false) await endProviderSessions(tx, id);
      await recordAudit(tx, {
        action: patch.enabled ? "identity.sso.provider.enabled" : "identity.sso.provider.disabled",
        target,
      });
    }
    const provider = await getProvider(s, id, tx);
    if (!provider) return { ok: false, failure: "not_found" };
    return { ok: true, provider };
  });
}

export type DeleteOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: "not_found" | "managed_by_helm" | "identities_linked" };

/** Deletes a console provider no identity is linked to (otherwise: disable it). */
export function deleteProvider(s: ProviderStore, id: string): Promise<DeleteOutcome> {
  return s.db.transaction(async (tx): Promise<DeleteOutcome> => {
    const row = await lockRow(tx, id);
    if (!row) return { ok: false, failure: "not_found" };
    if (row.managedBy === "helm") return { ok: false, failure: "managed_by_helm" };
    const [linked] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(ssoIdentities)
      .where(eq(ssoIdentities.providerId, id));
    if (Number(linked?.n ?? 0) > 0) return { ok: false, failure: "identities_linked" };
    await endProviderSessions(tx, id);
    await tx.delete(ssoProviders).where(eq(ssoProviders.id, id));
    await recordAudit(tx, {
      action: "identity.sso.provider.deleted",
      target: { providerId: id, slug: row.slug },
    });
    return { ok: true };
  });
}

/**
 * A provider's client secret for the sign-in flow (SSO-3): opened from the envelope (console) or
 * taken from the mounted Secret (Helm). Undefined when there is none or it does not open.
 */
export async function revealClientSecret(
  s: ProviderStore,
  id: string,
): Promise<string | undefined> {
  const [row] = await s.db
    .select({
      slug: ssoProviders.slug,
      managedBy: ssoProviders.managedBy,
      sealed: ssoProviders.clientSecretSealed,
    })
    .from(ssoProviders)
    .where(eq(ssoProviders.id, id));
  if (!row) return undefined;
  if (row.managedBy === "helm") return s.settings.helmSecrets.get(row.slug);
  if (!row.sealed || !s.envelope) return undefined;
  try {
    return s.envelope.openString(row.sealed, clientSecretContext(id));
  } catch {
    return undefined;
  }
}

export interface HelmSeedResult {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  /** Slugs the values declare that a console provider already holds: left alone. */
  readonly conflicts: readonly string[];
  /** Helm providers no longer in the values: disabled, kept (identities may name them). */
  readonly retired: readonly string[];
  /**
   * Helm providers whose values move the tenant, issuer or subject claim while identities are
   * linked (review finding 5): left as they are, nothing applied.
   */
  readonly locked: readonly string[];
}

/**
 * Start-up upsert of the providers the chart declares (`managed_by: helm`): created, updated to
 * match the values, or disabled once the values drop them. Never touches a console provider of
 * the same slug. No discovery runs here, so an unreachable IdP never delays or stops the start
 * (local sign-in never depends on it). Changes are audited as the system; an unchanged restart
 * writes nothing.
 */
export async function seedHelmProviders(
  db: KobeDb,
  settings: SsoSettings,
): Promise<HelmSeedResult> {
  return db.transaction(async (tx) => {
    // One writer at a time across replicas starting together.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('kobe.sso.helm_seed'))`);
    const created: string[] = [];
    const updated: string[] = [];
    const conflicts: string[] = [];
    const retired: string[] = [];
    const locked: string[] = [];
    const existing = await tx.select().from(ssoProviders);
    const bySlug = new Map(existing.map((r) => [r.slug, r]));
    for (const p of settings.helmProviders) {
      const values = {
        displayName: p.displayName,
        kind: p.kind,
        issuer: p.issuer,
        tenantId: p.tenantId,
        clientId: p.clientId,
        subjectClaim: p.subjectClaim,
        accessClaim: p.accessClaim,
        mfaRule: p.mfaRule,
        allowedEmailDomains: [...p.allowedEmailDomains],
        jitProvisioning: p.jitProvisioning,
        enabled: p.enabled,
        maxSessionHours: p.maxSessionHours,
      };
      const row = bySlug.get(p.slug);
      if (!row) {
        const [inserted] = await tx
          .insert(ssoProviders)
          .values({ ...values, slug: p.slug, managedBy: "helm" })
          .returning({ id: ssoProviders.id });
        if (!inserted) throw new Error("helm sso provider insert returned no row");
        await recordAudit(tx, {
          actor: SYSTEM_ACTOR,
          action: "identity.sso.provider.created",
          target: { providerId: inserted.id, slug: p.slug, kind: p.kind },
        });
        if (p.enabled) {
          await recordAudit(tx, {
            actor: SYSTEM_ACTOR,
            action: "identity.sso.provider.enabled",
            target: { providerId: inserted.id, slug: p.slug },
          });
        }
        created.push(p.slug);
        continue;
      }
      if (row.managedBy !== "helm") {
        conflicts.push(p.slug);
        continue;
      }
      const moves = IDENTITY_KEYS.some((k) => !same(values[k], row[k]));
      if (moves && (await hasIdentities(tx, row.id))) {
        locked.push(p.slug);
        continue;
      }
      const { enabled, ...rest } = values;
      const differs = (Object.keys(rest) as (keyof typeof rest)[]).some(
        (k) => !same(rest[k], row[k]),
      );
      if (!differs && enabled === row.enabled) continue;
      await tx
        .update(ssoProviders)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(ssoProviders.id, row.id));
      const target = { providerId: row.id, slug: p.slug };
      if (differs) {
        await recordAudit(tx, {
          actor: SYSTEM_ACTOR,
          action: "identity.sso.provider.updated",
          target,
        });
      }
      if (enabled !== row.enabled) {
        if (!enabled) await endProviderSessions(tx, row.id);
        await recordAudit(tx, {
          actor: SYSTEM_ACTOR,
          action: enabled ? "identity.sso.provider.enabled" : "identity.sso.provider.disabled",
          target,
        });
      }
      updated.push(p.slug);
    }
    const declared = new Set(settings.helmProviders.map((p) => p.slug));
    for (const row of existing) {
      if (row.managedBy !== "helm" || declared.has(row.slug) || !row.enabled) continue;
      await tx
        .update(ssoProviders)
        .set({ enabled: false, updatedAt: sql`now()` })
        .where(and(eq(ssoProviders.id, row.id), eq(ssoProviders.managedBy, "helm")));
      await endProviderSessions(tx, row.id);
      await recordAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: "identity.sso.provider.disabled",
        target: { providerId: row.id, slug: row.slug },
      });
      retired.push(row.slug);
    }
    return { created, updated, conflicts, retired, locked };
  });
}
