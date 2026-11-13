/**
 * Memory notifications in the bell (KOBE-645, v1.3 SM22): their words and deep links. Each kind
 * links to where the person decides (curators' queue, a project's suggestions, To review) or sees
 * the outcome. The target pages read the query parameter to open the object: `proposal`,
 * `suggestion`, `site_proposal` (the object id) and `review` (a learning pass's candidates); the
 * pages that build those views (KOBE-396, KOBE-397, KOBE-403, KOBE-652) honour them.
 */
import type { NotificationKind } from "@kobe/protocol";
import type { KobeNotification } from "./api";

/** Where each memory surface lives. Site memory's console section arrives with KOBE-385/403. */
export const MEMORY_PAGES = {
  me: "/me/memory",
  workspace: "/admin/team/memory",
  site: "/admin/site/memory",
  project: (projectId: string) => `/me/projects/${encodeURIComponent(projectId)}`,
} as const;

export interface MemoryLink {
  readonly href: string;
  /** The button's words ("Open …"). */
  readonly label: string;
}

const withParam = (path: string, key: string, id: string | undefined) =>
  id ? `${path}?${key}=${encodeURIComponent(id)}` : path;

/** The link of a memory kind about `objectId` (none: the list it belongs to). */
function linkOf(
  kind: NotificationKind,
  objectId: string | undefined,
  projectId: string | undefined,
  scope: "team" | "site" | undefined,
): MemoryLink | null {
  switch (kind) {
    case "memory.scope.near_full":
      return scope === "site"
        ? { href: MEMORY_PAGES.site, label: "Open Site memory" }
        : { href: MEMORY_PAGES.workspace, label: "Open Workspace memory" };
    case "memory.proposal.received":
      return {
        href: withParam(MEMORY_PAGES.workspace, "proposal", objectId),
        label: "Open the proposal",
      };
    case "memory.proposal.accepted":
    case "memory.proposal.dismissed":
    case "memory.proposal.changes_requested":
    case "memory.proposal.expired":
      return { href: withParam(MEMORY_PAGES.me, "proposal", objectId), label: "Open My memory" };
    case "memory.suggestion.received":
    case "memory.suggestion.accepted":
    case "memory.suggestion.dismissed":
    case "memory.suggestion.expired":
      return projectId
        ? {
            href: withParam(MEMORY_PAGES.project(projectId), "suggestion", objectId),
            label: "Open the project",
          }
        : { href: "/me/projects", label: "Open projects" };
    case "memory.site_proposal.received":
    case "memory.site_proposal.confirmed":
      return {
        href: withParam(MEMORY_PAGES.site, "site_proposal", objectId),
        label: "Open the Site proposal",
      };
    case "memory.site_proposal.accepted":
    case "memory.site_proposal.dismissed":
    case "memory.site_proposal.changes_requested":
    case "memory.site_proposal.expired":
      return {
        href: withParam(MEMORY_PAGES.workspace, "site_proposal", objectId),
        label: "Open Workspace memory",
      };
    default:
      return null;
  }
}

/**
 * The bell's deep link for a memory notification; null for every other kind and for
 * `memory.review.candidates_ready`, which opens its conversation (the To review section is there).
 */
export function memoryNotificationLink(n: KobeNotification): MemoryLink | null {
  if (n.kind === "memory.review.candidates_ready") return null;
  if (n.kind === "memory.review.digest") {
    // The list the rolled-up notifications belong to.
    return n.relatedKind === "memory.review.reminder" || !n.relatedKind
      ? { href: MEMORY_PAGES.me, label: "Open My memory" }
      : linkOf(n.relatedKind, undefined, undefined, undefined);
  }
  if (n.kind === "memory.review.reminder") {
    return n.relatedKind
      ? linkOf(n.relatedKind, n.memoryObjectId, n.projectId, undefined)
      : { href: withParam(MEMORY_PAGES.me, "review", n.memoryObjectId), label: "Open To review" };
  }
  return linkOf(n.kind, n.memoryObjectId, n.projectId, n.memoryScope);
}

/** What a digest rolls up, in the plural ("Workspace memory proposals"). */
const PLURAL: Partial<Record<NotificationKind, string>> = {
  "memory.scope.near_full": "memory limit notices",
  "memory.review.reminder": "review reminders",
  "memory.review.candidates_ready": "notices of memories to review",
  "memory.proposal.changes_requested": "Workspace memory proposals sent back for changes",
  "memory.proposal.expired": "expired Workspace memory proposals",
  "memory.suggestion.expired": "expired project note suggestions",
  "memory.site_proposal.confirmed": "confirmed Site memory proposals",
  "memory.site_proposal.changes_requested": "Site memory proposals sent back for changes",
  "memory.site_proposal.expired": "expired Site memory proposals",
  "memory.proposal.received": "Workspace memory proposals",
  "memory.proposal.accepted": "accepted Workspace memory proposals",
  "memory.proposal.dismissed": "dismissed Workspace memory proposals",
  "memory.suggestion.received": "project note suggestions",
  "memory.suggestion.accepted": "accepted project note suggestions",
  "memory.suggestion.dismissed": "dismissed project note suggestions",
  "memory.site_proposal.received": "Site memory proposals",
  "memory.site_proposal.accepted": "accepted Site memory proposals",
  "memory.site_proposal.dismissed": "dismissed Site memory proposals",
};

const REMINDER: Partial<Record<NotificationKind, string>> = {
  "memory.proposal.received": "A Workspace memory proposal has waited a week for review",
  "memory.suggestion.received": "A project note suggestion has waited a week for review",
  "memory.site_proposal.received": "A Site memory proposal has waited a week for review",
  "memory.site_proposal.confirmed": "A confirmed Site memory proposal has waited a week for review",
  "memory.site_proposal.changes_requested":
    "A Site memory proposal sent back for changes has waited a week",
};

/** The headline of a memory kind; null for other kinds. */
export function memoryNotificationTitle(n: KobeNotification): string | null {
  const who = (fallback: string) => n.actorName ?? fallback;
  switch (n.kind) {
    case "memory.scope.near_full":
      return `${n.memoryScope === "site" ? "Site" : "Workspace"} memory is 80% full`;
    case "memory.review.digest":
      return `${n.itemCount ?? 0} more ${(n.relatedKind && PLURAL[n.relatedKind]) ?? "memory notifications"} in the last hour`;
    case "memory.review.reminder":
      return (
        (n.relatedKind && REMINDER[n.relatedKind]) ?? "Memories are waiting for you in To review"
      );
    case "memory.review.candidates_ready": {
      const count = n.itemCount ?? 0;
      return count === 1 ? "1 memory to review" : `${count} memories to review`;
    }
    case "memory.proposal.received":
      return `${who("A member")} proposed a Workspace memory`;
    case "memory.proposal.changes_requested":
      return `${who("A curator")} asked for changes to your Workspace memory proposal`;
    case "memory.proposal.expired":
      return "Your Workspace memory proposal expired undecided";
    case "memory.suggestion.expired":
      return "Your project note suggestion expired undecided";
    case "memory.site_proposal.confirmed":
      return `${who("A Team admin")} confirmed a Site memory proposal`;
    case "memory.site_proposal.changes_requested":
      return `${who("A Site curator")} asked for changes to a Site memory proposal from this Workspace`;
    case "memory.site_proposal.expired":
      return "A Site memory proposal from this Workspace expired undecided";
    case "memory.proposal.accepted":
      return `${who("A curator")} accepted your Workspace memory proposal`;
    case "memory.proposal.dismissed":
      return `${who("A curator")} dismissed your Workspace memory proposal`;
    case "memory.suggestion.received":
      return `${who("A reader")} suggested a project note`;
    case "memory.suggestion.accepted":
      return `${who("An editor")} accepted your project note suggestion`;
    case "memory.suggestion.dismissed":
      return `${who("An editor")} dismissed your project note suggestion`;
    case "memory.site_proposal.received":
      return `${who("A Team admin")} proposed a Site memory`;
    case "memory.site_proposal.accepted":
      return `${who("A Site curator")} accepted a Site memory proposal from this Workspace`;
    case "memory.site_proposal.dismissed":
      return `${who("A Site curator")} dismissed a Site memory proposal from this Workspace`;
    default:
      return null;
  }
}

/** What a memory notification is about (the line under the headline). */
export function memoryNotificationLabel(n: KobeNotification): string {
  const kind = n.kind === "memory.review.reminder" ? (n.relatedKind ?? n.kind) : n.kind;
  if (kind.startsWith("memory.suggestion.")) return "Project notes";
  if (kind.startsWith("memory.site_proposal.") || n.memoryScope === "site") return "Site memory";
  if (kind.startsWith("memory.proposal.") || n.memoryScope === "team") return "Workspace memory";
  return "Memory";
}
