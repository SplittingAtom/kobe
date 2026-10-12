"use client";

import { useEffect, useState } from "react";
import { XIcon } from "lucide-react";
import { threadExportUrl, type TeamRetentionNotice } from "../../lib/chat/api";
import { InlineLink } from "../shell/text-links";
import { useChatSession } from "./kobe-runtime";
import styles from "./chat.module.css";

const LABELS: Readonly<Record<string, string>> = {
  "30d": "30 days",
  "90d": "90 days",
  "1y": "1 year",
};

/** Browser storage key of the last notice this viewer closed (a per-viewer convenience only). */
const DISMISSED_KEY = "kobe.retentionNotice.dismissed";

/** Identifies one notice, so a new period or date shows again after an earlier one was closed. */
const noticeId = (teamId: string, upcoming: NonNullable<TeamRetentionNotice["upcoming"]>) =>
  `${teamId}:${upcoming.period}:${upcoming.effectiveAt}`;

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null; // storage blocked (private window, previews): the notice simply shows
  }
}

function writeDismissed(id: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, id);
  } catch {
    // storage blocked: closing still hides it for this page view
  }
}

/**
 * Upcoming retention shortening (user decision 2026-10-04): when the team's period is about to get
 * shorter, every member sees when older conversations start being deleted, with the export link.
 * A member can close it; it stays closed in this browser until the notice changes.
 */
export function RetentionNotice() {
  const session = useChatSession();
  const [upcoming, setUpcoming] = useState<TeamRetentionNotice["upcoming"]>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  useEffect(() => {
    let live = true;
    void session.api.retention().then((res) => {
      if (live && res.ok) setUpcoming(res.data.upcoming);
    });
    return () => {
      live = false;
    };
  }, [session]);
  if (!upcoming) return null;
  const id = noticeId(session.teamId, upcoming);
  if (dismissed === id) return null;
  const when = new Date(upcoming.effectiveAt);
  const dismiss = () => {
    writeDismissed(id);
    setDismissed(id);
  };
  return (
    <div className={styles.dismissibleBanner} role="status">
      <p>
        Conversations older than {LABELS[upcoming.period] ?? upcoming.period} will be deleted from{" "}
        <time dateTime={upcoming.effectiveAt}>
          {when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        </time>
        .{" "}
        <InlineLink href={threadExportUrl(session.teamId)} download>
          Export your conversations
        </InlineLink>{" "}
        to keep a copy.
      </p>
      <button
        type="button"
        className="hover:bg-muted inline-flex size-7 shrink-0 items-center justify-center rounded-md"
        aria-label="Dismiss retention notice"
        title="Dismiss"
        onClick={dismiss}
      >
        <XIcon aria-hidden className="size-4" />
      </button>
    </div>
  );
}
