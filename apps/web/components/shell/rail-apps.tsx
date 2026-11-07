"use client";

import { useCallback, useContext, useEffect, useState } from "react";
import { MY_CONNECTOR_KEYS, listRailApps, type RailApps } from "../../lib/apps/app-cards";
import { ChatSessionContext } from "../chat/kobe-runtime";
import type { RailApi } from "./rail-state";
import { RAIL_TAB_IDS } from "./rail-tabs";
import { RailPickers } from "./rail-pickers";
import { InlineLink } from "./text-links";
import styles from "./rail.module.css";

/**
 * The rail's Apps tab (KOBE-440, spec MA3, MA8, MA11; a tab beside Files since KOBE-448): the
 * Pickers section (KOBE-460, `rail-pickers.tsx`), which runs one picker app live, and nothing
 * else since KOBE-559 (Chris, 2026-11-07): the list of every app that stood under it is gone; apps
 * are launched from the composer's + menu (KOBE-451). No tab when the member has no app. An app
 * missing only the member's own key still shows "Add your key", linking to My connector keys.
 */
export const APPS_SECTION_ID = RAIL_TAB_IDS.apps.panel;

/** The member's apps as read, and whether that read failed (it then shows none). */
export interface RailAppsState extends RailApps {
  readonly failed: boolean;
  /** Reads the list again (a picker found its app no longer live, KOBE-460). */
  refresh(): void;
}

/** The member's apps, read when the rail mounts, when the team changes and on `refresh`. */
export function useRailApps(): RailAppsState | null {
  const session = useContext(ChatSessionContext);
  const teamId = session?.teamId;
  const [reads, setReads] = useState(0);
  const refresh = useCallback(() => setReads((n) => n + 1), []);
  const [apps, setApps] = useState<{ teamId: string; value: RailAppsState } | null>(null);
  useEffect(() => {
    if (teamId === undefined) return undefined;
    let alive = true;
    void listRailApps(teamId).then(
      (res) => {
        // Apps are a nicety: a failed read shows none (and settles, so the rail never waits).
        if (alive) setApps({ teamId, value: normalized(res.ok ? res.data : null, refresh) });
      },
      () => {
        if (alive) setApps({ teamId, value: normalized(null, refresh) });
      },
    );
    return () => {
      alive = false;
    };
  }, [teamId, reads, refresh]);
  return apps !== null && apps.teamId === teamId ? apps.value : null;
}

function normalized(data: Partial<RailApps> | null, refresh: () => void): RailAppsState {
  return {
    apps: Array.isArray(data?.apps) ? data.apps : [],
    needsKey: Array.isArray(data?.needsKey) ? data.needsKey : [],
    failed: data === null,
    refresh,
  };
}

export function hasRailApps(apps: RailApps | null): apps is RailApps {
  return apps !== null && (apps.apps.length > 0 || apps.needsKey.length > 0);
}

export function RailApps({
  rail,
  apps,
  hidden,
}: {
  readonly rail: RailApi;
  readonly apps: RailAppsState;
  /** Files is the tab on screen: kept mounted (its launch state, the picker), not shown. */
  readonly hidden: boolean;
}) {
  return (
    <section
      id={APPS_SECTION_ID}
      role="tabpanel"
      aria-labelledby={RAIL_TAB_IDS.apps.tab}
      tabIndex={-1}
      className={styles.appsSection}
      hidden={hidden}
      {...(rail.pickerShown ? { "data-picker-live": "" } : {})}
    >
      <RailPickers
        rail={rail}
        apps={apps.apps}
        settled={!apps.failed}
        visible={!hidden && !rail.collapsed}
        onUnavailable={apps.refresh}
      />
      {apps.needsKey.length > 0 && (
        <ul className={styles.appsList}>
          {apps.needsKey.map((hint) => (
            <li key={`${hint.connectorId}:${hint.title}`} className={styles.appHint}>
              <span>
                <InlineLink href={MY_CONNECTOR_KEYS}>Add your key</InlineLink> to use {hint.title}{" "}
                from {hint.connectorName}.
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
