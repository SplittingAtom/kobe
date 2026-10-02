/** Agent summaries as `/v1/agents` and `/v1/install/gallery/agents` return them (KOBE-45). */

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
  readonly revision: number;
  readonly updatedAt: string;
  readonly canEdit: boolean;
}

export interface AgentSaved {
  readonly agent: AgentSummary;
  readonly warnings?: readonly unknown[];
}
