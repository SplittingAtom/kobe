import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sessions, users } from "./auth.js";
import { CONNECTOR_GRANT_SEALED_MAX } from "./connector-grants.js";
import { teamRole } from "./team-members.js";
import { teams } from "./teams.js";

// Single sign-on (OIDC) and SCIM provisioning (KOBE-625, spec docs/specs/sso-oidc-scim.md §4–§10).
// All site-wide (identity domain): site configuration and identity links, no team content. Only
// `sso_access_mappings` names teams (a `teamReferencing` entry). Kobe stores no IdP access,
// refresh or ID token anywhere.

export const SSO_PROVIDER_KINDS = ["entra", "oidc"] as const;
export type SsoProviderKind = (typeof SSO_PROVIDER_KINDS)[number];
/** Which ID token claim keys the identity: Entra `oid` (matches SCIM `externalId`), else `sub`. */
export const SSO_SUBJECT_CLAIMS = ["oid", "sub"] as const;
/** Which claim carries the values the access mappings match (app roles recommended, §7). */
export const SSO_ACCESS_CLAIMS = ["roles", "groups"] as const;
export const SSO_MANAGED_BY = ["console", "helm"] as const;
export const SSO_LINKED_VIA = ["jit", "local_proof", "admin_expected", "scim"] as const;
export type SsoLinkedVia = (typeof SSO_LINKED_VIA)[number];

/** Default MFA rule (§8): any RFC 8176 `amr` value that proves a second factor. */
export const SSO_DEFAULT_MFA_RULE = {
  amr_any: ["mfa", "hwk", "swk", "fido", "otp", "sc"],
  acr_any: [],
  acrs_any: [],
} as const;

/** Bounds on the short text columns (claim values, subjects, names). */
export const SSO_TEXT_MAX = 256;
export const SSO_URL_MAX = 2048;
const MAX = sql.raw(String(SSO_TEXT_MAX));
const inList = (values: readonly string[]) =>
  sql.raw(`(${values.map((v) => `'${v}'`).join(", ")})`);

/**
 * One OIDC identity provider (§4). The client secret of a console-managed provider is stored only
 * as KOBE-107 envelope text (`e1.<kid>...`, context `kind: "sso_client_secret"`, `recordId: id`),
 * never plaintext, and no API returns it. A Helm-managed provider's secret stays in the referenced
 * Kubernetes Secret and is never copied here. Deleting a provider is refused while an identity is
 * linked or an SSO session is live (disable it instead); its mappings, SCIM tokens and SCIM
 * groups go with it.
 */
export const ssoProviders = pgTable(
  "sso_providers",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** URL-safe, unique: `/api/auth/sso/callback/<slug>`, `/v1/scim/v2/<slug>`. */
    slug: text().notNull().unique(),
    displayName: text().notNull(),
    kind: text().$type<SsoProviderKind>().notNull(),
    /** The exact issuer discovery must report (Entra: built from `tenant_id`). */
    issuer: text().notNull(),
    clientId: text().notNull(),
    /** KOBE-107 envelope text (`e1.` prefix); NULL exactly when the provider is Helm-managed. */
    clientSecretSealed: text(),
    /** KEK id of `client_secret_sealed` (`Envelope.keyIdOf`), so a rotation sweep finds stale rows. */
    clientSecretKeyId: text(),
    /** Entra directory (tenant) id; required for `entra`, so `common`/`organizations` can't be named. */
    tenantId: uuid(),
    subjectClaim: text().$type<(typeof SSO_SUBJECT_CLAIMS)[number]>().notNull(),
    accessClaim: text().$type<(typeof SSO_ACCESS_CLAIMS)[number]>().notNull(),
    /** §8: `{amr_any, acr_any, acrs_any}`; the server validates the shape. */
    mfaRule: jsonb().notNull().default(SSO_DEFAULT_MFA_RULE),
    /** Domains an admin-expected link may match (§6); not used for sign-in itself. */
    allowedEmailDomains: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    jitProvisioning: boolean().notNull().default(true),
    /** Off until an admin turns it on (after discovery succeeded). */
    enabled: boolean().notNull().default(false),
    /** Optional: SSO sessions end after this many hours, earlier than local ones (§9). */
    maxSessionHours: integer(),
    managedBy: text().$type<(typeof SSO_MANAGED_BY)[number]>().notNull().default("console"),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("sso_providers_slug", sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{0,62}$'`),
    check("sso_providers_display_name", sql`char_length(${t.displayName}) BETWEEN 1 AND 100`),
    check("sso_providers_kind", sql`${t.kind} IN ${inList(SSO_PROVIDER_KINDS)}`),
    check(
      "sso_providers_issuer",
      sql`${t.issuer} ~ '^https://[^[:space:]]+$' AND char_length(${t.issuer}) <= ${sql.raw(String(SSO_URL_MAX))}`,
    ),
    check("sso_providers_client_id", sql`char_length(${t.clientId}) BETWEEN 1 AND ${MAX}`),
    check("sso_providers_entra_tenant", sql`${t.kind} <> 'entra' OR ${t.tenantId} IS NOT NULL`),
    check("sso_providers_subject_claim", sql`${t.subjectClaim} IN ${inList(SSO_SUBJECT_CLAIMS)}`),
    check("sso_providers_access_claim", sql`${t.accessClaim} IN ${inList(SSO_ACCESS_CLAIMS)}`),
    check("sso_providers_managed_by", sql`${t.managedBy} IN ${inList(SSO_MANAGED_BY)}`),
    // Console: secret sealed in the row. Helm: read from the Secret, never stored (§4).
    check(
      "sso_providers_secret_source",
      sql`(${t.managedBy} = 'console' AND ${t.clientSecretSealed} IS NOT NULL AND ${t.clientSecretKeyId} IS NOT NULL)
        OR (${t.managedBy} = 'helm' AND ${t.clientSecretSealed} IS NULL AND ${t.clientSecretKeyId} IS NULL)`,
    ),
    check(
      "sso_providers_client_secret_sealed",
      sql`${t.clientSecretSealed} IS NULL OR (${t.clientSecretSealed} ~ '^e1\\.[A-Za-z0-9_.-]+$' AND char_length(${t.clientSecretSealed}) <= ${sql.raw(String(CONNECTOR_GRANT_SEALED_MAX))})`,
    ),
    check(
      "sso_providers_client_secret_key_id",
      sql`${t.clientSecretKeyId} IS NULL OR char_length(${t.clientSecretKeyId}) BETWEEN 1 AND 64`,
    ),
    check(
      "sso_providers_mfa_rule",
      sql`jsonb_typeof(${t.mfaRule}) = 'object' AND octet_length(${t.mfaRule}::text) <= 4096`,
    ),
    check("sso_providers_allowed_email_domains", sql`cardinality(${t.allowedEmailDomains}) <= 50`),
    check(
      "sso_providers_max_session_hours",
      sql`${t.maxSessionHours} IS NULL OR ${t.maxSessionHours} BETWEEN 1 AND 8760`,
    ),
  ],
);

/**
 * A Kobe user linked to an IdP identity (§6): key (`provider_id`, `subject` = the value of the
 * provider's `subject_claim`), never email. Kept apart from Better Auth's `accounts`, so its
 * account endpoints never see these links and no IdP token is stored. One identity per user and
 * provider. Unlinking deletes the row.
 */
export const ssoIdentities = pgTable(
  "sso_identities",
  {
    providerId: uuid()
      .notNull()
      .references(() => ssoProviders.id),
    subject: text().notNull(),
    // Users are deactivated, never deleted; NO ACTION keeps a stray delete from losing the link.
    userId: uuid()
      .notNull()
      .references(() => users.id),
    linkedVia: text().$type<SsoLinkedVia>().notNull(),
    /** The address the identity carried when linked (shown to admins); not a key. */
    emailAtLink: text(),
    linkedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSignInAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.providerId, t.subject] }),
    unique("sso_identities_provider_user").on(t.providerId, t.userId),
    index("sso_identities_user_idx").on(t.userId),
    check("sso_identities_subject", sql`char_length(${t.subject}) BETWEEN 1 AND ${MAX}`),
    check("sso_identities_linked_via", sql`${t.linkedVia} IN ${inList(SSO_LINKED_VIA)}`),
    check(
      "sso_identities_email_at_link",
      sql`${t.emailAtLink} IS NULL OR char_length(${t.emailAtLink}) BETWEEN 1 AND 320`,
    ),
  ],
);

/**
 * Site configuration naming teams (§7): a claim value (an app-role value or a group object id)
 * grants a team role. Team roles only (SSO6): `team_role` has no site role. Applied by
 * `applyIdpAccess` at sign-in and on SCIM changes, each team in its own `withTeam()`.
 */
export const ssoAccessMappings = pgTable(
  "sso_access_mappings",
  {
    id: uuid().primaryKey().defaultRandom(),
    providerId: uuid()
      .notNull()
      .references(() => ssoProviders.id, { onDelete: "cascade" }),
    claimValue: text().notNull(),
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    role: teamRole().notNull(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("sso_access_mappings_key").on(t.providerId, t.claimValue, t.teamId),
    // A team admin reads the mappings that target their team.
    index("sso_access_mappings_team_idx").on(t.teamId),
    check(
      "sso_access_mappings_claim_value",
      sql`char_length(${t.claimValue}) BETWEEN 1 AND ${MAX}`,
    ),
  ],
);

/**
 * How one sign-in session was made through SSO (§8, §9). Kept out of Better Auth's `sessions` like
 * `session_active_teams`, and goes away with the session. Not backed up (it references
 * `sessions`). `mfa_satisfied` lets `requireSession` accept the IdP's MFA for `require_2fa`.
 * Deleting a provider is refused while it has rows: its sessions are ended first.
 */
export const sessionSsoContexts = pgTable(
  "session_sso_contexts",
  {
    sessionId: uuid()
      .primaryKey()
      .references(() => sessions.id, { onDelete: "cascade" }),
    providerId: uuid()
      .notNull()
      .references(() => ssoProviders.id),
    mfaSatisfied: boolean().notNull(),
    amr: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    acr: text(),
    authTime: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("session_sso_contexts_provider_idx").on(t.providerId),
    check("session_sso_contexts_amr", sql`cardinality(${t.amr}) <= 32`),
    check(
      "session_sso_contexts_acr",
      sql`${t.acr} IS NULL OR char_length(${t.acr}) BETWEEN 1 AND ${MAX}`,
    ),
  ],
);

/**
 * SCIM bearer tokens of one provider (§10): stored as a SHA-256 hash (hex) only, shown once.
 * Revoked, never deleted (the app role has no DELETE and may update only `last_used_at` and
 * `revoked_at`; a trigger makes revocation final). They go with their provider.
 */
export const scimTokens = pgTable(
  "scim_tokens",
  {
    id: uuid().primaryKey().defaultRandom(),
    providerId: uuid()
      .notNull()
      .references(() => ssoProviders.id, { onDelete: "cascade" }),
    tokenHash: text().notNull().unique(),
    /** The token's first characters, for display (`kobe_scim_` + a few). */
    prefix: text().notNull(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("scim_tokens_provider_live_idx")
      .on(t.providerId)
      .where(sql`${t.revokedAt} IS NULL`),
    check("scim_tokens_token_hash", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("scim_tokens_prefix", sql`char_length(${t.prefix}) BETWEEN 1 AND 32`),
  ],
);

/** A group pushed by the provider's SCIM client (§10); `external_id` = the Entra object id. */
export const scimGroups = pgTable(
  "scim_groups",
  {
    id: uuid().primaryKey().defaultRandom(),
    providerId: uuid()
      .notNull()
      .references(() => ssoProviders.id, { onDelete: "cascade" }),
    externalId: text().notNull(),
    displayName: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("scim_groups_provider_external").on(t.providerId, t.externalId),
    check("scim_groups_external_id", sql`char_length(${t.externalId}) BETWEEN 1 AND ${MAX}`),
    check("scim_groups_display_name", sql`char_length(${t.displayName}) BETWEEN 1 AND ${MAX}`),
  ],
);

/** Members of a SCIM group; each change re-runs `applyIdpAccess` for the user (§10). */
export const scimGroupMembers = pgTable(
  "scim_group_members",
  {
    groupId: uuid()
      .notNull()
      .references(() => scimGroups.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index("scim_group_members_user_idx").on(t.userId),
  ],
);
