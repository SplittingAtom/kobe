"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  DRAFT_TABS,
  openingDraftTab,
  rememberDraftTab,
  showDraftTabInAddress,
  type DraftTab,
} from "../../lib/skills/draft-tabs";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/console";

const LABELS: Readonly<Record<DraftTab, string>> = {
  define: "Define",
  test: "Test",
  eval: "Eval",
};

/**
 * The draft page's tabs (KOBE-459): Define, Test and Eval, the console's Radix tabs (arrow keys,
 * Home/End). The page opens on `?tab=`, else the tab last used for this draft, else Define (the
 * editor renders once the draft has loaded, in the browser, so reading the memory here never
 * differs from a server render). The chosen tab goes into the address and the memory. Leaving
 * Define writes pending edits (`flush`), and Test and Eval write them again before they run
 * anything. A tab is mounted the first time it is shown and then kept (hidden), so a test chat
 * or an eval's progress survives a trip to Define.
 */
export function WorkbenchTabs({
  draftId,
  requested,
  flush,
  panels,
}: {
  readonly draftId: string;
  /** The address's `?tab=` (null: none). */
  readonly requested: DraftTab | null;
  readonly flush: () => Promise<unknown>;
  /** A tab's content; `shown` is false while it is kept hidden. */
  readonly panels: (tab: DraftTab, shown: boolean) => ReactNode;
}) {
  const [tab, setTab] = useState<DraftTab>(() => openingDraftTab(requested, draftId));
  const [visited, setVisited] = useState<ReadonlySet<DraftTab>>(() => new Set([tab]));
  // A link to another ?tab= while the page is open (the page itself stays mounted).
  useEffect(() => {
    if (requested !== null) setTab(requested);
  }, [requested]);
  useEffect(() => {
    showDraftTabInAddress(tab);
    rememberDraftTab(draftId, tab);
    setVisited((prev) => (prev.has(tab) ? prev : new Set([...prev, tab])));
  }, [draftId, tab]);

  const choose = (value: string) => {
    const next = DRAFT_TABS.find((t) => t === value);
    if (!next || next === tab) return;
    if (tab === "define") void flush();
    setTab(next);
  };

  return (
    <Tabs value={tab} onValueChange={choose} className="mt-4">
      <TabsList label="Draft">
        {DRAFT_TABS.map((t) => (
          <TabsTrigger key={t} value={t}>
            {LABELS[t]}
          </TabsTrigger>
        ))}
      </TabsList>
      {DRAFT_TABS.map((t) =>
        visited.has(t) || t === tab ? (
          <TabsContent key={t} value={t} forceMount hidden={t !== tab} className="min-w-0">
            {panels(t, t === tab)}
          </TabsContent>
        ) : null,
      )}
    </Tabs>
  );
}
