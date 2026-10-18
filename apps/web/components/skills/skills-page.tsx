"use client";

import { useState } from "react";
import { EmptyState, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/console";
import { MySkillChoices } from "../admin/team/skill-editor/my-skill-choices";
import { SkillList } from "./skill-list";
import { WorkbenchList } from "./workbench-list";

/** The Skills page's tabs (spec SK9), in order; `?tab=` names one. */
export const SKILL_TABS = ["catalog", "team", "mine", "workbench"] as const;
export type SkillTab = (typeof SKILL_TABS)[number];

const LABELS: Readonly<Record<SkillTab, string>> = {
  catalog: "Catalog",
  team: "Team",
  mine: "Mine",
  workbench: "Workbench",
};

/** The tab a `?tab=` value names; Team when it names none. */
export function skillTab(value: string | string[] | undefined): SkillTab {
  const v = Array.isArray(value) ? value[0] : value;
  return (SKILL_TABS as readonly string[]).includes(v ?? "") ? (v as SkillTab) : "team";
}

/** Keeps the open tab in the address (so a reload or a shared link opens it), without a reload. */
function rememberTab(tab: SkillTab): void {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", tab);
  window.history.replaceState(window.history.state, "", url);
}

/**
 * The member's Skills page (KOBE-321, spec SK9): every skill they can see in the active team, and
 * the Workbench where skills are written. One place to author skills: the consoles keep only
 * their admin views.
 */
export function SkillsPage({ initialTab = "team" }: { readonly initialTab?: SkillTab }) {
  const [tab, setTab] = useState<SkillTab>(initialTab);
  return (
    <>
      <PageHeader
        title="Skills"
        description="Skills teach agents how to do a task. Write and test them in the Workbench; each saved version is immutable."
      />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = skillTab(value);
          setTab(next);
          rememberTab(next);
        }}
      >
        <TabsList label="Skills">
          {SKILL_TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {LABELS[t]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="catalog">
          <EmptyState title="The Site catalog comes with the Skills Registry.">
            Kobe's own skills already load in your runs; Mine shows which ones are on.
          </EmptyState>
        </TabsContent>
        <TabsContent value="team">
          <SkillList scope="team" />
        </TabsContent>
        <TabsContent value="mine">
          <SkillList scope="personal" />
          <MySkillChoices />
        </TabsContent>
        <TabsContent value="workbench">
          <WorkbenchList />
        </TabsContent>
      </Tabs>
    </>
  );
}
