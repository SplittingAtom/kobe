"use client";

import { useState } from "react";
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/console";
import { MySkillChoices } from "../admin/team/skill-editor/my-skill-choices";
import { CatalogForks } from "./catalog-forks";
import { CatalogTab } from "./catalog-tab";
import { SkillList } from "./skill-list";
import { MySubmissions } from "./my-submissions";
import { WorkbenchList } from "./workbench-list";
import { showTabInAddress } from "../../lib/shell/tab-address";
import { SKILL_TABS, skillTab, type SkillTab } from "../../lib/skills/tabs";

const LABELS: Readonly<Record<SkillTab, string>> = {
  catalog: "Catalog",
  team: "Team",
  mine: "Mine",
  workbench: "Workbench",
};

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
          showTabInAddress(next);
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
          <CatalogTab />
        </TabsContent>
        <TabsContent value="team">
          <SkillList scope="team" />
          <CatalogForks />
        </TabsContent>
        <TabsContent value="mine">
          <SkillList scope="personal" />
          <MySkillChoices />
        </TabsContent>
        <TabsContent value="workbench">
          <WorkbenchList />
          <MySubmissions />
        </TabsContent>
      </Tabs>
    </>
  );
}
