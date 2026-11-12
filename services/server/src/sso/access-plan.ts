import { TEAM_ROLES, type TeamRole } from "@kobe/db";

/**
 * The pure half of the access-mapping engine (KOBE-627, spec sso-oidc-scim §7): which team roles a
 * set of IdP values asks for, and what that means for one team's row. `access.ts` applies it.
 */

/** Longest claim value a mapping can hold (`sso_access_mappings_claim_value`). */
export const MAX_IDP_VALUE_LENGTH = 256;
/**
 * More values than this is refused rather than truncated (a truncated list would remove access).
 * Entra caps a token's groups at 200 before overage; SCIM memberships are bounded the same way.
 */
export const MAX_IDP_VALUES = 2000;

/** Most to least privileged: `TEAM_ROLES` order (spec D8). */
const RANK: ReadonlyMap<TeamRole, number> = new Map(
  TEAM_ROLES.map((role, i) => [role, TEAM_ROLES.length - i]),
);

export function isTeamRole(role: unknown): role is TeamRole {
  return typeof role === "string" && RANK.has(role as TeamRole);
}

export function higherRole(a: TeamRole, b: TeamRole): TeamRole {
  return (RANK.get(a) ?? 0) >= (RANK.get(b) ?? 0) ? a : b;
}

/** The token's or SCIM's values as a clean set: strings only, 1..256 chars, no duplicates. */
export function normalizeIdpValues(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  if (values.length > MAX_IDP_VALUES) {
    throw new Error(`applyIdpAccess: too many IdP values (${values.length} > ${MAX_IDP_VALUES})`);
  }
  const clean = values.filter(
    (v): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_IDP_VALUE_LENGTH,
  );
  return [...new Set(clean)];
}

export interface MappingRule {
  readonly claimValue: string;
  readonly teamId: string;
  readonly role: TeamRole;
}

/**
 * §7 rule 1: per team, the highest role among the mappings the values match (exact match). A
 * mapping can only name a team role (the column is the `team_role` enum); anything else is a bug
 * and stops the apply rather than granting it (SSO6: no site roles).
 */
export function desiredTeamRoles(
  mappings: readonly MappingRule[],
  values: readonly string[],
): Map<string, TeamRole> {
  const have = new Set(values);
  const desired = new Map<string, TeamRole>();
  for (const m of mappings) {
    if (!isTeamRole(m.role)) {
      throw new Error("applyIdpAccess: a mapping names a site role or no team role (SSO6)");
    }
    if (!have.has(m.claimValue)) continue;
    const current = desired.get(m.teamId);
    desired.set(m.teamId, current === undefined ? m.role : higherRole(current, m.role));
  }
  return desired;
}

export interface TeamRow {
  readonly role: TeamRole;
  readonly addedVia: string | null;
}

export type TeamPlan =
  | { readonly kind: "none" }
  | { readonly kind: "add"; readonly role: TeamRole }
  | { readonly kind: "change"; readonly from: TeamRole; readonly to: TeamRole }
  | { readonly kind: "remove"; readonly role: TeamRole }
  /** A row the provider doesn't manage differs from what the mappings ask: it wins (§7 rule 3). */
  | { readonly kind: "conflict" };

/**
 * §7 rules 2-3 for one team: the provider adds, changes and removes only rows tagged with its own
 * `idp:<id>`; any other row (manual, another provider's, the Skill reviewer grant's) is never
 * touched, and a differing desire there is reported as a conflict.
 */
export function planTeam(input: {
  readonly row: TeamRow | null;
  readonly desired: TeamRole | undefined;
  readonly tag: string;
}): TeamPlan {
  const { row, desired, tag } = input;
  if (row === null)
    return desired === undefined ? { kind: "none" } : { kind: "add", role: desired };
  if (row.addedVia !== tag) {
    return desired !== undefined && desired !== row.role ? { kind: "conflict" } : { kind: "none" };
  }
  if (desired === undefined) return { kind: "remove", role: row.role };
  return desired === row.role ? { kind: "none" } : { kind: "change", from: row.role, to: desired };
}
