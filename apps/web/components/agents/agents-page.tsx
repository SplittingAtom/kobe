"use client";

import Link from "next/link";
import { useState } from "react";
import { NEW_AGENT_HREF } from "../../lib/agents/redirects";
import {
  AGENT_TABS,
  agentTabParam,
  openingAgentTab,
  rememberAgentTab,
  showAgentTabInAddress,
  type AgentTab,
} from "../../lib/agents/tabs";
import { Button, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/console";
import { useTeamAccess } from "../admin/console-context";
import { RosterTab } from "./roster-tab";

const LABELS: Readonly<Record<AgentTab, string>> = {
  personal: "Personal",
  team: "Team",
  site: "Site",
};

const DESCRIPTIONS: Readonly<Record<AgentTab, string>> = {
  personal:
    "Your own agents: only you edit and publish them. Assign one to your team or the site to let others run it.",
  team: "What this team's members can run: the team's own agents and the personal agents assigned to it.",
  site: "What every team can run: the gallery and the personal agents assigned to the site.",
};

/** The team console's builder for team-owned agents (AR13: "Create for the team", builders). */
const CREATE_FOR_TEAM_HREF = "/admin/team/agents/new";

/**
 * The Agents page (KOBE-569, spec agents-roster AR1): Personal, Team and Site rosters in tabs.
 * The open tab is in the address and remembered in this browser; "New agent" always creates a
 * personal agent, and the Team tab keeps "Create for the team" for builders.
 */
export function AgentsPage({ requestedTab = null }: { readonly requestedTab?: AgentTab | null }) {
  const access = useTeamAccess();
  const [tab, setTab] = useState<AgentTab>(() => openingAgentTab(requestedTab));
  const canBuild = access.permissions.includes("team.agents.build");
  return (
    <>
      <PageHeader
        title="Agents"
        description={DESCRIPTIONS[tab]}
        actions={
          <>
            <Button asChild>
              <Link href="/me/connectors">My connector keys</Link>
            </Button>
            {tab === "team" && canBuild && (
              <Button asChild>
                <Link href={CREATE_FOR_TEAM_HREF}>Create for the team</Link>
              </Button>
            )}
            <Button asChild variant="primary">
              <Link href={NEW_AGENT_HREF}>New agent</Link>
            </Button>
          </>
        }
      />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = agentTabParam(value) ?? "personal";
          setTab(next);
          rememberAgentTab(next);
          showAgentTabInAddress(next);
        }}
      >
        <TabsList label="Agents">
          {AGENT_TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {LABELS[t]}
            </TabsTrigger>
          ))}
        </TabsList>
        {AGENT_TABS.map((t) => (
          <TabsContent key={t} value={t}>
            <RosterTab tab={t} />
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}
