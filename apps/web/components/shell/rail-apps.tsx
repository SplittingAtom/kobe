"use client";

import { AppWindowIcon } from "lucide-react";
import { useCallback, useContext, useEffect, useState } from "react";
import {
  MY_CONNECTOR_KEYS,
  listRailApps,
  type RailApp,
  type RailApps,
} from "../../lib/apps/app-cards";
import { useAppLaunch } from "../apps/use-app-launch";
import { ChatSessionContext } from "../chat/kobe-runtime";
import type { RailApi } from "./rail-state";
import { RAIL_TAB_IDS } from "./rail-tabs";
import { RailPickers } from "./rail-pickers";
import { InlineLink } from "./text-links";
import styles from "./rail.module.css";

/**
 * The rail's Apps tab (KOBE-440, spec MA3, MA8, MA11; a tab beside Files since KOBE-448): the
 * member's apps; no tab when there is none. A click launches the app into the conversation on screen as
 * an app card (the server calls its opening tool as the member; no run, no model call), or into
 * a new thread from the new-thread view, a thread shared read-only or one in Trash. During a run
 * the card waits as a chip in the thread's queue. An app missing only the member's own key shows
 * "Add your key", linking to My connector keys. Above the list, the Pickers section (KOBE-460,
 * `rail-pickers.tsx`) runs one picker app live; the list below still lists every app.
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
  // The one launch rule (KOBE-440, KOBE-455): this thread, a new one, or a chip during a run.
  const { busy, error, intoNewThread, launch: launchApp } = useAppLaunch();
  const launch = async (app: RailApp) => {
    if ((await launchApp(app)) && rail.drawer) rail.closeDrawer();
  };

  const where = intoNewThread ? "in a new conversation" : "in this conversation";
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
      <ul className={styles.appsList}>
        {apps.apps.map((app) => (
          <li key={app.appId}>
            <button
              type="button"
              className={styles.appRow}
              aria-label={`Open ${app.title} ${where}`}
              title={`Open ${app.title} from ${app.connectorName} ${where}`}
              aria-busy={busy === app.appId || undefined}
              disabled={busy !== null}
              onClick={() => void launch(app)}
            >
              <AppWindowIcon aria-hidden className="size-4 shrink-0" />
              <span className="truncate">{app.title}</span>
              <span className="text-muted-foreground ms-auto truncate text-xs">
                {app.connectorName}
              </span>
            </button>
          </li>
        ))}
        {apps.needsKey.map((hint) => (
          <li key={`${hint.connectorId}:${hint.title}`} className={styles.appHint}>
            <span>
              <InlineLink href={MY_CONNECTOR_KEYS}>Add your key</InlineLink> to use {hint.title}{" "}
              from {hint.connectorName}.
            </span>
          </li>
        ))}
      </ul>
      {error !== null && (
        <p role="alert" className={styles.appsError}>
          {error}
        </p>
      )}
    </section>
  );
}
