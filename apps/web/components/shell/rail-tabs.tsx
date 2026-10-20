"use client";

import { useRef, type KeyboardEvent } from "react";
import type { RailTab } from "./rail-state";
import styles from "./rail.module.css";

/** The rail section's tabs and their panels' ids (KOBE-448). */
export const RAIL_TAB_IDS = {
  files: { tab: "kobe-rail-tab-files", panel: "kobe-rail-files" },
  apps: { tab: "kobe-rail-tab-apps", panel: "kobe-rail-apps" },
} as const;

const ORDER: readonly RailTab[] = ["files", "apps"];
const LABELS: Readonly<Record<RailTab, string>> = { files: "Files", apps: "Apps" };

/**
 * Files | Apps, the rail's one section (KOBE-448): an ARIA tablist with automatic activation.
 * Left and Right move between the tabs (wrapping), Home and End go to the ends; only the chosen
 * tab is in the Tab order. Both panels stay mounted, so each keeps its state while hidden.
 */
export function RailTabList({
  tab,
  onChange,
}: {
  readonly tab: RailTab;
  onChange(tab: RailTab): void;
}) {
  const buttons = useRef(new Map<RailTab, HTMLButtonElement>());
  const go = (next: RailTab) => {
    onChange(next);
    buttons.current.get(next)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const at = ORDER.indexOf(tab);
    const next =
      e.key === "ArrowRight"
        ? ORDER[(at + 1) % ORDER.length]
        : e.key === "ArrowLeft"
          ? ORDER[(at - 1 + ORDER.length) % ORDER.length]
          : e.key === "Home"
            ? ORDER[0]
            : e.key === "End"
              ? ORDER[ORDER.length - 1]
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    go(next);
  };
  return (
    <div role="tablist" aria-label="Files and apps" className={styles.tabs} onKeyDown={onKeyDown}>
      {ORDER.map((id) => (
        <button
          key={id}
          ref={(el) => {
            if (el) buttons.current.set(id, el);
            else buttons.current.delete(id);
          }}
          type="button"
          role="tab"
          id={RAIL_TAB_IDS[id].tab}
          aria-selected={tab === id}
          aria-controls={RAIL_TAB_IDS[id].panel}
          tabIndex={tab === id ? 0 : -1}
          className={styles.tab}
          onClick={() => go(id)}
        >
          {LABELS[id]}
        </button>
      ))}
    </div>
  );
}
