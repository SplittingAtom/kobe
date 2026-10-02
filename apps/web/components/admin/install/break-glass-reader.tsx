"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiError } from "../../../lib/api/client";
import {
  readGrantEntries,
  readGrantThreads,
  type BreakGlassGrant,
  type GrantEntry,
  type GrantThread,
} from "../../../lib/admin/api/install/break-glass";
import { ErrorNotice } from "../error-notice";
import { DateTime } from "../parts";
import styles from "../admin.module.css";

/** The text of a Pi message entry, when it has one; otherwise the entry as JSON. */
export function entryText(entry: GrantEntry): string {
  if (entry.payloadOffloaded) return "(stored in object storage; not shown here)";
  const message = entry.payload.message as { role?: unknown; content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((part: unknown) =>
        part && typeof part === "object" && "text" in part && typeof part.text === "string"
          ? part.text
          : null,
      )
      .filter((t): t is string => t !== null);
    if (texts.length > 0) return texts.join("\n");
  }
  return JSON.stringify(entry.payload, null, 2);
}

function roleOf(entry: GrantEntry): string {
  const role = (entry.payload.message as { role?: unknown } | undefined)?.role;
  return typeof role === "string" ? role : entry.type;
}

/**
 * Read-only view of a team's threads under an active grant. Each page load is a separate, audited
 * read; the server re-checks the grant every time, so a revocation or expiry shows up as an error
 * on the next click. Nothing here can change team content: the API offers no write.
 */
export function BreakGlassReader({
  grant,
  onClose,
}: {
  readonly grant: BreakGlassGrant;
  readonly onClose: () => void;
}) {
  const [threads, setThreads] = useState<readonly GrantThread[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<GrantThread | null>(null);
  const [entries, setEntries] = useState<readonly GrantEntry[]>([]);
  const [after, setAfter] = useState<number | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  async function loadThreads(next: string | null) {
    setLoading(true);
    const res = await readGrantThreads(grant.id, next);
    setLoading(false);
    if (!res.ok) return setError(res.error);
    setError(null);
    setThreads((prev) => (next ? [...prev, ...res.data.threads] : res.data.threads));
    setCursor(res.data.nextCursor);
  }

  async function loadEntries(thread: GrantThread, from: number) {
    setLoading(true);
    const res = await readGrantEntries(grant.id, thread.threadId, from);
    setLoading(false);
    if (!res.ok) return setError(res.error);
    setError(null);
    setOpen(thread);
    setEntries((prev) => (from > 0 ? [...prev, ...res.data.entries] : res.data.entries));
    setAfter(res.data.nextAfter);
  }

  useEffect(() => {
    heading.current?.focus();
    void loadThreads(null);
    // Loads once per grant; later pages load on demand.
  }, [grant.id]);

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Break-glass: {grant.team.name}
      </h1>
      <div className={styles.banner} role="note">
        Read-only access, recorded in the team&apos;s audit log with every page you open. Access
        ends <DateTime value={grant.expiresAt} />.
      </div>
      <p>
        <button type="button" onClick={onClose}>
          Back to break-glass
        </button>
      </p>
      {error && <ErrorNotice error={error} />}
      {loading && <p role="status">Loading…</p>}
      {open ? (
        <section aria-label={`Thread ${open.title ?? open.threadId}`}>
          <h2>{open.title ?? "Untitled thread"}</h2>
          <p>
            <button type="button" onClick={() => setOpen(null)}>
              All threads
            </button>
          </p>
          <ol>
            {entries.map((e) => (
              <li key={e.entryId}>
                <strong>{roleOf(e)}</strong> · <DateTime value={e.createdAt} />
                <pre style={{ whiteSpace: "pre-wrap" }}>{entryText(e)}</pre>
              </li>
            ))}
          </ol>
          {entries.length === 0 && !loading && <p>No entries.</p>}
          {after !== null && (
            <button type="button" onClick={() => void loadEntries(open, after)}>
              Load more
            </button>
          )}
        </section>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>Threads in scope</caption>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Owner</th>
                <th scope="col">Last activity</th>
                <th scope="col">
                  <span className={styles.visuallyHidden}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {threads.map((t) => (
                <tr key={t.threadId}>
                  <td>
                    {t.title ?? "Untitled thread"}
                    {t.deletedAt && <> · in Trash</>}
                  </td>
                  <td>{t.ownerUserId}</td>
                  <td>
                    <DateTime value={t.lastActivityAt} />
                  </td>
                  <td>
                    <button type="button" onClick={() => void loadEntries(t, 0)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {threads.length === 0 && !loading && !error && <p>No threads in scope.</p>}
          {cursor && (
            <button type="button" onClick={() => void loadThreads(cursor)}>
              Load more
            </button>
          )}
        </div>
      )}
    </>
  );
}
