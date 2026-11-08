"use client";

import type { AgentRosterTab } from "@kobe/protocol";
import type { GalleryScore } from "../../lib/admin/api/agents";
import { listGalleryScores } from "../../lib/admin/api/team/agents";
import { listGalleryAgents, type GalleryAgentSummary } from "../../lib/admin/api/site/gallery";
import type { ApiResult } from "../../lib/api/client";
import { useResource } from "../admin/use-resource";

/** No call: what a tab that doesn't need the list holds instead. */
const none = <T>(): Promise<ApiResult<readonly T[]>> =>
  Promise.resolve({ ok: true, status: 200, data: [] });

/**
 * What the Site tab adds to its rows (KOBE-570, AR12): every member sees the gallery's published
 * Orbit scores (KOBE-94); site admins also get the Gallery page's state per agent (Customized,
 * a newer repository version) from the Site console API, for Compare and Reset.
 */
export function useGalleryExtras(teamId: string, tab: AgentRosterTab, siteAdmin: boolean) {
  const onSite = tab === "site";
  const scores = useResource(() => (onSite ? listGalleryScores(teamId) : none<GalleryScore>()));
  const admin = useResource(() =>
    onSite && siteAdmin ? listGalleryAgents() : none<GalleryAgentSummary>(),
  );
  const byId: ReadonlyMap<string, GalleryAgentSummary> | null =
    onSite && siteAdmin && admin.state.status === "ready"
      ? new Map(admin.state.data.map((a) => [a.id, a]))
      : null;
  return {
    scores: onSite ? scores.state : null,
    gallery: byId,
    reloadGallery: admin.reload,
  };
}
