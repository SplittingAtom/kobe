/**
 * Admin console navigation (KOBE-20). Each console section is one file under `site/` or
 * `team/` exporting one `defineSiteSection(…)` / `defineTeamSection(…)`, listed with one line in
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

export type ConsoleKind = "site" | "team";

/** Site role as `/v1/me` reports it (null there means a plain user). */
export type SiteRole = "owner" | "admin" | "user";

/** Ticket ids for placeholders: `KOBE-44`. */
export type TicketId = `KOBE-${number}`;

export type SectionStatus =
  | { readonly kind: "ready" }
  | {
      readonly kind: "placeholder";
      readonly ticket: TicketId;
      /** Why the ticket is paused on purpose; absent while it is simply still to come. */
      readonly onHold?: string;
    };

export const SITE_GROUPS = [
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

export type SiteGroup = (typeof SITE_GROUPS)[number];
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

export interface SiteSection extends SectionBase {
  readonly console: "site";
  readonly group: SiteGroup;
  /** Least site role that may open it, mirroring the route's `site.*` permission. */
  readonly minRole: "admin" | "owner";
}

export interface TeamSection extends SectionBase {
  readonly console: "team";
  readonly group: TeamGroup;
  /** The `team.*` permission (from `GET /v1/team`) the section's API requires. */
  readonly permission: string;
}

export type ConsoleSection = SiteSection | TeamSection;

export function defineSiteSection(section: Omit<SiteSection, "console">): SiteSection {
  return { console: "site", ...section };
}

export function defineTeamSection(section: Omit<TeamSection, "console">): TeamSection {
  return { console: "team", ...section };
}

/**
 * The only tickets a placeholder may name, each with why it is still open (KOBE-291). Finished
 * work must never stay "coming soon": the ticket that builds a section adds its page, marks it
 * READY and removes its line here. `comingIn`/`onHold` accept only these ids (a type error
 * otherwise), and registry.test.ts fails when a listed ticket has a ledger in docs/ledger or is
 * recorded as done or merged in docs/RUN-LEDGER.md, or when no placeholder names it any more.
 */
export const OPEN_PLACEHOLDER_TICKETS = {
  "KOBE-63": "the web search provider choice is on hold (product owner)",
} as const satisfies Readonly<Record<TicketId, string>>;

export type OpenTicket = keyof typeof OPEN_PLACEHOLDER_TICKETS;

/** `{ kind: "placeholder", ticket }` for a section whose API an open ticket builds. */
export function comingIn(ticket: OpenTicket): SectionStatus {
  return { kind: "placeholder", ticket };
}

/** A placeholder whose ticket is paused on purpose; `reason` is shown with it ("on hold"). */
export function onHold(ticket: OpenTicket, reason: string): SectionStatus {
  return { kind: "placeholder", ticket, onHold: reason };
}

export const READY: SectionStatus = { kind: "ready" };

export interface CurrentUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface SiteAccess {
  readonly console: "site";
  readonly user: CurrentUser;
  readonly siteRole: SiteRole;
}

export interface TeamAccess {
  readonly console: "team";
  readonly user: CurrentUser;
  readonly team: { readonly id: string; readonly slug: string; readonly name: string };
  readonly role: TeamRole;
  readonly permissions: readonly string[];
}

export type ConsoleAccess = SiteAccess | TeamAccess;
