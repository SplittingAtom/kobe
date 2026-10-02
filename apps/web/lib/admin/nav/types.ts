/**
 * Admin console navigation (KOBE-20). Each console section is one file under `install/` or
 * `team/` exporting one `defineInstallSection(…)` / `defineTeamSection(…)`, listed with one line in
 * that folder's `index.ts`. Order comes from `group` + `order`, never from line order.
 *
 * The barrels use git's `union` merge driver (.gitattributes). That only helps a local
 * `git merge`: GitHub's merge button and its conflict check ignore it, so merge `origin/main`
 * locally before merging a PR that touches a barrel (docs/parallel-work.md). Union never reports a
 * conflict; `registry.test.ts` catches a lost or duplicated line (every section file exported,
 * ids unique, READY ⇔ `app/admin/<console>/<id>/page.tsx` exists).
 *
 * Visibility here is presentation only. Every page's data comes from an API that enforces the
 * same rule; `minRole` / `permission` mirror the server's check so people aren't shown dead ends.
 */
import type { TeamRole } from "../../teams";

export type ConsoleKind = "install" | "team";

/** Install role as `/v1/me` reports it (null there means a plain user). */
export type InstallRole = "owner" | "admin" | "user";

/** Ticket ids for placeholders: `KOBE-44`. */
export type TicketId = `KOBE-${number}`;

export type SectionStatus =
  { readonly kind: "ready" } | { readonly kind: "placeholder"; readonly ticket: TicketId };

export const INSTALL_GROUPS = [
  "People",
  "Teams and agents",
  "Models and connectors",
  "Safety",
  "Governance",
  "System",
] as const;

export const TEAM_GROUPS = [
  "People",
  "Agents and skills",
  "Models and spend",
  "Access",
  "Governance",
] as const;

export type InstallGroup = (typeof INSTALL_GROUPS)[number];
export type TeamGroup = (typeof TEAM_GROUPS)[number];

interface SectionBase {
  /** URL segment and unique id within its console: `/admin/<console>/<id>`. */
  readonly id: string;
  readonly label: string;
  /** One sentence for the console overview. */
  readonly description: string;
  /** Position within the group (ties broken by label); leave gaps (10, 20, …) for later entries. */
  readonly order: number;
  readonly status: SectionStatus;
}

export interface InstallSection extends SectionBase {
  readonly console: "install";
  readonly group: InstallGroup;
  /** Least install role that may open it, mirroring the route's `install.*` permission. */
  readonly minRole: "admin" | "owner";
}

export interface TeamSection extends SectionBase {
  readonly console: "team";
  readonly group: TeamGroup;
  /** The `team.*` permission (from `GET /v1/team`) the section's API requires. */
  readonly permission: string;
}

export type ConsoleSection = InstallSection | TeamSection;

export function defineInstallSection(section: Omit<InstallSection, "console">): InstallSection {
  return { console: "install", ...section };
}

export function defineTeamSection(section: Omit<TeamSection, "console">): TeamSection {
  return { console: "team", ...section };
}

/** `{ kind: "placeholder", ticket }` for a section whose API another ticket builds. */
export function comingIn(ticket: TicketId): SectionStatus {
  return { kind: "placeholder", ticket };
}

export const READY: SectionStatus = { kind: "ready" };

export interface CurrentUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface InstallAccess {
  readonly console: "install";
  readonly user: CurrentUser;
  readonly installRole: InstallRole;
}

export interface TeamAccess {
  readonly console: "team";
  readonly user: CurrentUser;
  readonly team: { readonly id: string; readonly slug: string; readonly name: string };
  readonly role: TeamRole;
  readonly permissions: readonly string[];
}

export type ConsoleAccess = InstallAccess | TeamAccess;
