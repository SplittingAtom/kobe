"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { AppWindowIcon } from "lucide-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  MY_CONNECTOR_KEYS,
  launchAppCard,
  listRailApps,
  type RailApp,
  type RailApps,
} from "../../lib/apps/app-cards";
import { ChatSessionContext, useKobeExtras } from "../chat/kobe-runtime";
import type { RailApi } from "./rail-state";
import { InlineLink } from "./text-links";
import styles from "./rail.module.css";

/**
 * The rail's Apps section (KOBE-440, spec MA3, MA8, MA11): the member's apps, between Threads and
 * Files, hidden when there is none. A click launches the app into the conversation on screen as
 * an app card (the server calls its opening tool as the member; no run, no model call), or into
 * a new thread from the new-thread view, a thread shared read-only or one in Trash. During a run
 * the card waits as a chip in the thread's queue. An app missing only the member's own key shows
 * "Add your key", linking to My connector keys.
 */
export const APPS_SECTION_ID = "kobe-rail-apps";

/** The member's apps, read when the rail mounts and when the team changes. */
export function useRailApps(): RailApps | null {
  const session = useContext(ChatSessionContext);
  const teamId = session?.teamId;
  const [apps, setApps] = useState<{ teamId: string; value: RailApps } | null>(null);
  useEffect(() => {
    if (teamId === undefined) return undefined;
    let alive = true;
    void listRailApps(teamId).then((res) => {
      // Apps are a nicety: a failed read shows none.
      if (alive && res.ok) setApps({ teamId, value: normalized(res.data) });
    });
    return () => {
      alive = false;
    };
  }, [teamId]);
  return apps !== null && apps.teamId === teamId ? apps.value : null;
}

function normalized(data: Partial<RailApps> | null): RailApps {
  return {
    apps: Array.isArray(data?.apps) ? data.apps : [],
    needsKey: Array.isArray(data?.needsKey) ? data.needsKey : [],
  };
}

export function hasRailApps(apps: RailApps | null): apps is RailApps {
  return apps !== null && (apps.apps.length > 0 || apps.needsKey.length > 0);
}

export function RailApps({
  rail,
  apps,
  focusSeq,
}: {
  readonly rail: RailApi;
  readonly apps: RailApps;
  /** Bumped by the collapsed rail's Apps icon: the section takes the focus once shown. */
  readonly focusSeq: number;
}) {
  const aui = useAui();
  const session = useContext(ChatSessionContext);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const summary = useKobeExtras()?.state.summary;
  // The member's own, live thread takes the card; anything else starts a new thread.
  const own = summary?.readOnly !== true && (summary?.deletedAt ?? null) === null;
  const target = remoteId !== undefined && own ? remoteId : null;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);
  const focused = useRef(0);
  useEffect(() => {
    if (focusSeq === focused.current || rail.collapsed) return;
    focused.current = focusSeq;
    section.current?.focus();
  }, [focusSeq, rail.collapsed]);

  const launch = useCallback(
    async (app: RailApp) => {
      if (!session || busy !== null) return;
      setBusy(app.appId);
      setError(null);
      const res = await launchAppCard(target, app.appId, session.teamId);
      setBusy(null);
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      if (rail.drawer) rail.closeDrawer();
      if (target === null) {
        session.threadCreated();
        aui.threads.switchToThread(res.data.threadId);
      } else {
        session.appCards.changed(target);
      }
    },
    [session, busy, target, rail, aui],
  );

  const where = target === null ? "in a new conversation" : "in this conversation";
  return (
    <section
      ref={section}
      id={APPS_SECTION_ID}
      aria-labelledby="kobe-rail-apps-title"
      tabIndex={-1}
      className={styles.appsSection}
    >
      <div className={styles.sectionHeader}>
        <h3 id="kobe-rail-apps-title" className={styles.sectionTitle}>
          Apps
        </h3>
      </div>
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
