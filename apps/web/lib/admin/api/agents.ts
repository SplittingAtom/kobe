/** Agent summaries as `/v1/agents` and `/v1/install/gallery/agents` return them (KOBE-45/46). */

export interface AgentSummary {
  readonly id: string;
  readonly scope: "team" | "personal" | "gallery";
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  readonly status: "active" | "suspended";
  readonly ownerUserId: string | null;
  readonly currentVersion: number | null;
  /** Set when a published agent was deleted: archived, its versions stay pinned (KOBE-46). */
  readonly archivedAt?: string | null;
  readonly revision: number;
  readonly updatedAt: string;
  readonly canEdit: boolean;
  /** Publish and rollback (a separate right from editing the draft). */
  readonly canPublish?: boolean;
  /** The caller may read the definition, which exporting a version needs (KOBE-91). */
  readonly canExport?: boolean;
  /** Where a fork was copied from (KOBE-87); null for agents written from scratch. */
  readonly forkedFrom?: { readonly agentId: string; readonly version: number | null } | null;
}

export interface AgentSaved {
  readonly agent: AgentSummary;
  readonly warnings?: readonly unknown[];
}

/** The draft revision as an ETag for If-Match: publish exactly what the console showed. */
export const revisionTag = (agent: Pick<AgentSummary, "revision">): string => `"${agent.revision}"`;

/** Status as shown in consoles: archived wins over active/suspended. */
export function agentStatusLabel(agent: Pick<AgentSummary, "status" | "archivedAt">): string {
  if (agent.archivedAt) return "Archived";
  return agent.status === "active" ? "Active" : "Suspended";
}

/** A gallery agent version's published Orbit score (`gallery-scores`, KOBE-94); install-level. */
export interface GalleryScore {
  readonly agentId: string;
  readonly version: number;
  readonly status: "passed" | "blocked";
  /** 0 to 1. */
  readonly attackSuccessRate: number;
  readonly attempts: number;
  readonly threshold: number;
  readonly evaluatedAt: string;
}
