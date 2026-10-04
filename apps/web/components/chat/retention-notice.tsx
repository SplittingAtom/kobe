"use client";

import { useEffect, useState } from "react";
import { threadExportUrl, type TeamRetentionNotice } from "../../lib/chat/api";
import { useChatSession } from "./kobe-runtime";
import styles from "./chat.module.css";

const LABELS: Readonly<Record<string, string>> = {
  "30d": "30 days",
  "90d": "90 days",
  "1y": "1 year",
};

/**
 * Upcoming retention shortening (user decision 2026-10-04): when the team's period is about to get
 * shorter, every member sees when older conversations start being deleted, with the export link.
 */
export function RetentionNotice() {
  const session = useChatSession();
  const [upcoming, setUpcoming] = useState<TeamRetentionNotice["upcoming"]>(null);
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
  const when = new Date(upcoming.effectiveAt);
  return (
    <p className={styles.banner} role="status">
      Conversations older than {LABELS[upcoming.period] ?? upcoming.period} will be deleted from{" "}
      <time dateTime={upcoming.effectiveAt}>
        {when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
      </time>
      .{" "}
      <a href={threadExportUrl(session.teamId)} download>
        Export your conversations
      </a>{" "}
      to keep a copy.
    </p>
  );
}
