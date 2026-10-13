"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { tabDomId } from "../../lib/files/preview";
import { IconAction } from "../shell/icon-action";

export interface ArtifactTabView {
  readonly id: string;
  readonly title: string;
}

export const artifactTabId = (id: string) => `kobe-artifact-tab-${tabDomId(id)}`;
export const artifactTabpanelId = (id: string) => `kobe-artifact-tabpanel-${tabDomId(id)}`;

/**
 * The artifact column's tabs (CE6, KOBE-200): WAI-ARIA tabs with automatic activation. Arrow
 * keys, Home and End move between tabs; Delete closes the focused one. Each tab has a close icon
 * beside it (out of the tab order, so the strip is one stop).
 */
export function ArtifactTabStrip({
  tabs,
  active,
  onSelect,
  onClose,
}: {
  readonly tabs: readonly ArtifactTabView[];
  readonly active: string;
  onSelect(id: string): void;
  onClose(id: string): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  /**
   * Set by the strip's own keys and close icons, only when they change the tabs: the new active
   * tab takes focus. Never left set, or a later auto-open would take focus from the composer.
   */
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    list.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [active, tabs.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1;
    const target: Readonly<Record<string, number>> = {
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowRight: index === last ? 0 : index + 1,
      Home: 0,
      End: last,
    };
    const tab = tabs[index];
    if (e.key === "Delete" && tab) {
      e.preventDefault();
      refocus.current = true;
      onClose(tab.id);
      return;
    }
    const next = target[e.key] === undefined ? undefined : tabs[target[e.key] ?? 0];
    if (!next) return;
    e.preventDefault();
    if (next.id === active) return;
    refocus.current = true;
    onSelect(next.id);
  };

  return (
    <div ref={list} role="tablist" aria-label="Open artifacts" className="flex overflow-x-auto">
      {tabs.map((tab, index) => {
        const selected = tab.id === active;
        return (
          <div
            key={tab.id}
            className="flex shrink-0 items-center gap-0.5 border-e pe-1 data-[selected]:bg-muted"
            data-selected={selected ? "" : undefined}
          >
            <button
              type="button"
              role="tab"
              id={artifactTabId(tab.id)}
              aria-selected={selected}
              aria-controls={artifactTabpanelId(tab.id)}
              aria-keyshortcuts="Delete"
              tabIndex={selected ? 0 : -1}
              className="max-w-48 truncate px-3 py-1.5 text-xs aria-selected:font-medium"
              onClick={() => onSelect(tab.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
            >
              {tab.title}
            </button>
            <IconAction
              command="artifact-close"
              label={`Close ${tab.title}`}
              size="sm"
              tabIndex={-1}
              onClick={() => {
                refocus.current = true;
                onClose(tab.id);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
