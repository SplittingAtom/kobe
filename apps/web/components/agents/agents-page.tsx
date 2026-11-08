"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { NEW_AGENT_HREF } from "../../lib/agents/redirects";
import {
  AGENT_TABS,
  agentTabParam,
  DEFAULT_AGENT_TAB,
  openingAgentTab,
  rememberAgentTab,
  type AgentTab,
} from "../../lib/agents/tabs";
import { showTabInAddress } from "../../lib/shell/tab-address";
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
 * The open tab: `?tab=` (read live, so a link to another tab works while the page is open), else
 * the last one used in this browser, else Personal. The tab is put in the address on mount and on
 * every switch, so a copied link opens it.
 */
function useAgentTab(): readonly [AgentTab, (tab: AgentTab) => void] {
  const requested = agentTabParam(useSearchParams()?.get("tab") ?? undefined);
  const [tab, setTab] = useState<AgentTab>(() => openingAgentTab(requested));
  const choose = (next: AgentTab) => {
    setTab(next);
    rememberAgentTab(next);
    showTabInAddress(next);
  };
  useEffect(() => {
    showTabInAddress(tab);
    // Once, on mount: later switches write the address themselves.
  }, []);
  useEffect(() => {
    if (requested !== null && requested !== tab) choose(requested);
    // Only a new `?tab=` (a link, Back) switches; the tab's own changes are already in it.
  }, [requested]);
  return [tab, choose];
}

/**
 * The Agents page (KOBE-569, spec agents-roster AR1): Personal, Team and Site rosters in tabs.
 * A tab stays loaded once opened (its rows, pages and notices survive a look at another tab).
 * "New agent" always creates a personal agent; the Team tab keeps "Create for the team" for
 * builders.
 */
export function AgentsPage() {
  const access = useTeamAccess();
  const [tab, setTab] = useAgentTab();
  const [opened, setOpened] = useState<ReadonlySet<AgentTab>>(() => new Set([tab]));
  if (!opened.has(tab)) setOpened(new Set([...opened, tab]));
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
        onValueChange={(value) => setTab(agentTabParam(value) ?? DEFAULT_AGENT_TAB)}
      >
        <TabsList label="Agents">
          {AGENT_TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {LABELS[t]}
            </TabsTrigger>
          ))}
        </TabsList>
        {AGENT_TABS.filter((t) => opened.has(t)).map((t) => (
          <TabsContent key={t} value={t} forceMount hidden={t !== tab}>
            <RosterTab tab={t} />
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}
