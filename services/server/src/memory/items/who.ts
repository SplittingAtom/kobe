import type { SemanticMemoryScope, SiteGrant } from "@kobe/protocol";
import type { TeamRole } from "@kobe/db";
import {
  siteMemoryAllows,
  siteMemoryWriteAllows,
  teamMemoryAllows,
  type SiteRole,
} from "../../authz/permissions.js";
import type { EffectiveMemory } from "../switch-model.js";
import { disabled, notAllowed } from "./errors.js";

/**
 * The caller of the item store (KOBE-378), resolved per request: the Workspace role and steward
 * row (KOBE-380) for Workspace items, the site role and grants for Site items. `user` and
 * `portable` items need no rights: the store only ever reads the caller's own.
 */
export interface MemoryWho {
  readonly userId: string;
  readonly teamId: string;
  readonly teamRole: TeamRole;
  readonly memorySteward: boolean;
  readonly siteRole: SiteRole;
  readonly grants: readonly SiteGrant[];
}

/** What a write touches on a Site item (KOBE-380 review M-1): any Policy change needs admins. */
export interface WriteShape {
  /** The body names `policy` (true or false). */
  readonly policyField: boolean;
  /** The item is Policy now. */
  readonly targetIsPolicy: boolean;
}

/** Whether the caller curates this scope's items (Workspace: Team admins + stewards). */
export function curates(who: MemoryWho, scope: SemanticMemoryScope): boolean {
  if (scope === "user" || scope === "portable") return true;
  if (scope === "team")
    return teamMemoryAllows(
      { role: who.teamRole, memorySteward: who.memorySteward },
      "team.memory.curate",
    );
  return siteMemoryAllows(who, "site.memory.curate");
}

/**
 * Refuses a write the caller may not make: `team` items need `team.memory.curate`; Site items go
 * through {@link siteMemoryWriteAllows} (the `site.memory.policy` guard for every path that sets,
 * clears or edits Policy). Every store write calls this before touching a row.
 */
export function assertMayWrite(
  who: MemoryWho,
  scope: SemanticMemoryScope,
  shape: WriteShape = { policyField: false, targetIsPolicy: false },
): void {
  if (scope === "site") {
    if (!siteMemoryWriteAllows(who, { via: "item", ...shape }))
      throw notAllowed(
        shape.policyField || shape.targetIsPolicy
          ? "Only Site admins set or change Policy."
          : "Only Site admins and Site memory stewards change Site memories.",
      );
    return;
  }
  if (!curates(who, scope))
    throw notAllowed("Only Team admins and memory stewards change Workspace memories.");
}

/**
 * The switches (KOBE-381): the scope must be on for this Workspace. Policy follows only the Site
 * master (`policy`), so a Policy item stays readable and editable by Site admins while the
 * Workspace's Site memories are off.
 */
export function assertEnabled(
  e: EffectiveMemory,
  scope: SemanticMemoryScope,
  policy = false,
): void {
  if (scope === "site" && policy ? e.policy : e.scopes[scope]) return;
  throw disabled();
}

/** Site items show author ids only to Site admins and Site stewards (contract wall M6). */
export const seesSiteAuthors = (who: MemoryWho): boolean =>
  siteMemoryAllows(who, "site.memory.curate");
