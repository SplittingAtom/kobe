"use client";

import { useState } from "react";
import { fetchMyTeams } from "../../../lib/teams";
import { CuratorMemories } from "../../memory/curator-memories";
import { ExportPanel } from "../../memory/export-panel";
import { ImportPanel } from "../../memory/import-panel";
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/console";
import { useSiteAccess } from "../console-context";
import { ResourceView } from "../parts";
import { useResource } from "../use-resource";

/** Site roles that set Policy (`site.memory.policy`: Site admins and the Owner). */
const POLICY_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/**
 * Site console › Memory (KOBE-385; SM8, SM21, SM23): the Site's memories for Site admins and Site
 * memory stewards, with filters, edit, archive, restore, pin, tags, import and export, and the
 * Policy budget. Only Site admins make an item Policy or change one (the `site.memory.policy`
 * guard; the server refuses anyone else). The memory switches stay in Settings.
 *
 * Requests carry the session's active Workspace when there is one (`X-Kobe-Team`, which the
 * server needs on writes then); its switches don't limit curation (they govern what reaches its
 * runs).
 */
export function SiteMemoryPage() {
  const access = useSiteAccess();
  const canSetPolicy = POLICY_ROLES.has(access.siteRole);
  const active = useResource(async () => {
    try {
      const my = await fetchMyTeams();
      return { ok: true as const, status: 200, data: my?.activeTeamId ?? null };
    } catch {
      return { ok: true as const, status: 200, data: null };
    }
  });
  const [generation, setGeneration] = useState(0);
  return (
    <>
      <PageHeader title="Memory" />
      <ResourceView state={active.state} label="memory">
        {(activeTeamId) => {
          const teamId = activeTeamId ?? undefined;
          return (
            <Tabs defaultValue="memories">
              <TabsList label="Memory">
                <TabsTrigger value="memories">Memories</TabsTrigger>
                <TabsTrigger value="transfer">Import and export</TabsTrigger>
              </TabsList>
              <TabsContent value="memories">
                <p className="m-0 mb-4 text-console-muted">
                  Knowledge Kobe gives agents in every workspace that has Site memories on. Policy
                  reaches every workspace, always.
                  {canSetPolicy
                    ? " You can make a memory Policy and change Policy."
                    : " Only Site admins make a memory Policy or change Policy."}
                </p>
                <CuratorMemories
                  key={generation}
                  teamId={teamId}
                  scopes={[{ scope: "site", curate: true }]}
                  canSetPolicy={canSetPolicy}
                />
              </TabsContent>
              <TabsContent value="transfer">
                <ImportPanel
                  teamId={teamId}
                  scope="site"
                  onImported={() => setGeneration((g) => g + 1)}
                />
                <ExportPanel teamId={teamId} scope="site" />
              </TabsContent>
            </Tabs>
          );
        }}
      </ResourceView>
    </>
  );
}
