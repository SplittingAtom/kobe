import { z } from "zod";
import {
  and,
  asc,
  eq,
  ssoAccessMappings,
  ssoProviders,
  teams,
  type KobeDb,
  type TeamRole,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { teamRoleSchema } from "../teams/schemas.js";
import { MAX_IDP_VALUE_LENGTH } from "./access-plan.js";

/**
 * Access mappings (KOBE-627, spec sso-oidc-scim §7): an IdP value (app-role value or group object
 * id) grants a team role in one team. Edited only with `site.users.manage`; a team admin reads the
 * mappings that target their team. A mapping never names a site role (SSO6).
 */

/** Site role names someone might try to map: refused with their own code (SSO6). */
const SITE_ROLE_NAMES = new Set(["owner", "admin", "site_admin", "site_owner"]);

/** Visible characters and inner spaces only: no control characters, no outer whitespace. */
const claimValueSchema = z
  .string()
  .min(1)
  .max(MAX_IDP_VALUE_LENGTH)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\s\u0000-\u001f\u007f](?:[^\u0000-\u001f\u007f]*[^\s\u0000-\u001f\u007f])?$/u);

export const createMappingSchema = z
  .object({ claimValue: claimValueSchema, teamId: z.uuid(), role: teamRoleSchema })
  .strict();

export type MappingInputError = "site_role_not_mappable" | "invalid_request";

/** Parses a create body; a site role in `role` gets `site_role_not_mappable` (SSO6). */
export function parseCreateMapping(
  body: unknown,
):
  | { readonly ok: true; readonly value: z.infer<typeof createMappingSchema> }
  | { readonly ok: false; readonly error: MappingInputError } {
  const role = (body as { role?: unknown } | null)?.role;
  if (typeof role === "string" && SITE_ROLE_NAMES.has(role.toLowerCase())) {
    return { ok: false, error: "site_role_not_mappable" };
  }
  const parsed = createMappingSchema.safeParse(body);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: "invalid_request" };
}

export interface SiteMapping {
  readonly id: string;
  readonly providerId: string;
  readonly claimValue: string;
  readonly teamId: string;
  readonly teamSlug: string;
  readonly teamName: string;
  readonly role: TeamRole;
  readonly createdAt: string;
}

export interface MappingProvider {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly accessClaim: string;
  readonly enabled: boolean;
  readonly managedBy: string;
}

/** Every provider (for the console's picker) and its mappings, optionally one provider's only. */
export async function listSiteMappings(
  db: KobeDb,
  providerId?: string,
): Promise<{ providers: MappingProvider[]; mappings: SiteMapping[] }> {
  const providers = await db
    .select({
      id: ssoProviders.id,
      slug: ssoProviders.slug,
      displayName: ssoProviders.displayName,
      accessClaim: ssoProviders.accessClaim,
      enabled: ssoProviders.enabled,
      managedBy: ssoProviders.managedBy,
    })
    .from(ssoProviders)
    .orderBy(asc(ssoProviders.displayName), asc(ssoProviders.slug));
  const rows = await db
    .select({
      id: ssoAccessMappings.id,
      providerId: ssoAccessMappings.providerId,
      claimValue: ssoAccessMappings.claimValue,
      teamId: ssoAccessMappings.teamId,
      teamSlug: teams.slug,
      teamName: teams.name,
      role: ssoAccessMappings.role,
      createdAt: ssoAccessMappings.createdAt,
    })
    .from(ssoAccessMappings)
    .innerJoin(teams, eq(teams.id, ssoAccessMappings.teamId))
    .where(providerId ? eq(ssoAccessMappings.providerId, providerId) : undefined)
    .orderBy(asc(ssoAccessMappings.claimValue), asc(teams.name));
  return {
    providers,
    mappings: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  };
}

export interface TeamMapping {
  readonly id: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly claimValue: string;
  readonly role: TeamRole;
}

/** The mappings that target one team (Team console, read-only). */
export async function listTeamMappings(db: KobeDb, teamId: string): Promise<TeamMapping[]> {
  return db
    .select({
      id: ssoAccessMappings.id,
      providerId: ssoAccessMappings.providerId,
      providerName: ssoProviders.displayName,
      claimValue: ssoAccessMappings.claimValue,
      role: ssoAccessMappings.role,
    })
    .from(ssoAccessMappings)
    .innerJoin(ssoProviders, eq(ssoProviders.id, ssoAccessMappings.providerId))
    .where(eq(ssoAccessMappings.teamId, teamId))
    .orderBy(asc(ssoProviders.displayName), asc(ssoAccessMappings.claimValue));
}

export type CreateMappingResult =
  | { readonly ok: true; readonly mapping: SiteMapping }
  | {
      readonly ok: false;
      readonly error: "provider_not_found" | "team_not_found" | "mapping_exists";
    };

const UNIQUE_VIOLATION = "23505";
const pgCode = (err: unknown): string | undefined => {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.cause?.code ?? e?.code;
};

/** Adds a mapping (audited `identity.sso.mapping.created`). */
export async function createMapping(
  db: KobeDb,
  providerId: string,
  input: z.infer<typeof createMappingSchema>,
  createdBy: string,
): Promise<CreateMappingResult> {
  try {
    return await db.transaction(async (tx) => {
      const [provider] = await tx
        .select({ id: ssoProviders.id })
        .from(ssoProviders)
        .where(eq(ssoProviders.id, providerId))
        .for("share");
      if (!provider) return { ok: false as const, error: "provider_not_found" as const };
      const [team] = await tx
        .select({ id: teams.id, slug: teams.slug, name: teams.name })
        .from(teams)
        .where(eq(teams.id, input.teamId))
        .for("share");
      if (!team) return { ok: false as const, error: "team_not_found" as const };
      const [row] = await tx
        .insert(ssoAccessMappings)
        .values({ providerId, ...input, createdBy })
        .onConflictDoNothing()
        .returning();
      if (!row) return { ok: false as const, error: "mapping_exists" as const };
      await recordAudit(tx, {
        action: "identity.sso.mapping.created",
        target: { providerId, mappingId: row.id, teamId: team.id, role: row.role },
      });
      return {
        ok: true as const,
        mapping: {
          id: row.id,
          providerId,
          claimValue: row.claimValue,
          teamId: team.id,
          teamSlug: team.slug,
          teamName: team.name,
          role: row.role,
          createdAt: row.createdAt.toISOString(),
        },
      };
    });
  } catch (err) {
    if (pgCode(err) === UNIQUE_VIOLATION) return { ok: false, error: "mapping_exists" };
    throw err;
  }
}

/** Deletes one of a provider's mappings (audited `identity.sso.mapping.deleted`). */
export async function deleteMapping(
  db: KobeDb,
  providerId: string,
  mappingId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(ssoAccessMappings)
      .where(and(eq(ssoAccessMappings.id, mappingId), eq(ssoAccessMappings.providerId, providerId)))
      .returning();
    if (!row) return false;
    await recordAudit(tx, {
      action: "identity.sso.mapping.deleted",
      target: { providerId, mappingId: row.id, teamId: row.teamId, role: row.role },
    });
    return true;
  });
}
