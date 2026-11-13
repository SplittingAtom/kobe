"use client";

import { useState } from "react";
import { isUuid } from "../../lib/memory/ids";
import type { MemoryTarget } from "../../lib/memory/api";
import { memoryTabOf, showTabInUrl, type MemoryTab } from "../../lib/memory/tabs";
import { useTeamAccess } from "../admin/console-context";
import { MemoryPanel } from "../memory/memory-panel";
import { MyMemories } from "../memory/my-memories";
import { ProjectPicker } from "../projects/project-picker";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/console";

/** `?project=<uuid>` opens that project's memory instead of the person's own. */
function projectFromLocation(): string | null {
  const project = new URLSearchParams(window.location.search).get("project");
  return project !== null && isUuid(project) ? project : null;
}

/** Keeps the address in step with the picker, so a link or a refresh reopens the same memory. */
function showInUrl(projectId: string | null): void {
  const url = new URL(window.location.href);
  if (projectId === null) url.searchParams.delete("project");
  else url.searchParams.set("project", projectId);
  window.history.replaceState(null, "", url);
}

/**
 * The one Memory page (`/me/memory`, the bar's My memory; KOBE-384, SM5): **Memories** (default,
 * the Me editor) and **Notes** (the memory files of KOBE-158, unchanged, with the project picker
 * of KOBE-164). `?tab=notes` or `?project=` opens Notes.
 */
export function MyMemoryPage() {
  const teamId = useTeamAccess().team.id;
  const [tab, setTab] = useState<MemoryTab>(() => memoryTabOf(window.location.search));
  const [projectId, setProjectId] = useState(projectFromLocation);
  const target: MemoryTarget =
    projectId === null ? { scope: "user" } : { scope: "project", projectId };
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        const next: MemoryTab = value === "notes" ? "notes" : "memories";
        showTabInUrl(next);
        if (next === "notes") showInUrl(projectId);
        setTab(next);
      }}
    >
      <TabsList label="Memory">
        <TabsTrigger value="memories">Memories</TabsTrigger>
        <TabsTrigger value="notes">Notes</TabsTrigger>
      </TabsList>
      <TabsContent value="memories">
        <MyMemories teamId={teamId} />
      </TabsContent>
      <TabsContent value="notes">
        <ProjectPicker
          value={projectId}
          onChange={(id) => {
            showInUrl(id);
            setProjectId(id);
          }}
        />
        <MemoryPanel key={projectId ?? "me"} teamId={teamId} target={target} />
      </TabsContent>
    </Tabs>
  );
}
