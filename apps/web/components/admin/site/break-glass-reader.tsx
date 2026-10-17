"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiError } from "../../../lib/api/client";
import {
  readGrantEntries,
  readGrantThreads,
  type BreakGlassGrant,
  type GrantEntry,
  type GrantThread,
} from "../../../lib/admin/api/site/break-glass";
import { ErrorNotice } from "../error-notice";
import { DateTime } from "../parts";
import {
  Button,
  EmptyState,
  Notice,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/console";

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
      <header className="mb-4">
        <p className="m-0 mb-1 text-sm">
          <Button size="sm" onClick={onClose}>
            Back to break-glass
          </Button>
        </p>
        <h1
          ref={heading}
          tabIndex={-1}
          className="m-0 text-3xl leading-tight font-bold focus:outline-none"
        >
          Break-glass: {grant.team.name}
        </h1>
      </header>
      <Notice tone="warn" role="note">
        <p>
          Read-only access, recorded in the team&apos;s audit log with every page you open. Access
          ends <DateTime value={grant.expiresAt} />.
        </p>
      </Notice>
      {error && <ErrorNotice error={error} />}
      {loading && <p role="status">Loading…</p>}
      {open ? (
        <Section
          title={open.title ?? "Untitled thread"}
          actions={
            <Button size="sm" onClick={() => setOpen(null)}>
              All threads
            </Button>
          }
        >
          <ol
            aria-label={`Thread ${open.title ?? open.threadId}`}
            className="m-0 flex list-none flex-col gap-3 p-0"
          >
            {entries.map((e) => (
              <li key={e.entryId} className="rounded-lg border border-console-border p-3">
                <p className="m-0 text-sm">
                  <strong>{roleOf(e)}</strong> · <DateTime value={e.createdAt} />
                </p>
                <pre className="m-0 mt-2 font-[inherit] break-words whitespace-pre-wrap">
                  {entryText(e)}
                </pre>
              </li>
            ))}
          </ol>
          {entries.length === 0 && !loading && <EmptyState title="No entries." />}
          {after !== null && (
            <Button className="mt-3" onClick={() => void loadEntries(open, after)}>
              Load more
            </Button>
          )}
        </Section>
      ) : (
        <Section title="Threads in scope">
          <Table caption="Threads in scope" hideCaption>
            <TableHead>
              <TableRow>
                <TableHeader>Title</TableHeader>
                <TableHeader>Owner</TableHeader>
                <TableHeader>Last activity</TableHeader>
                <TableHeader>
                  <span className="sr-only">Actions</span>
                </TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {threads.map((t) => (
                <TableRow key={t.threadId}>
                  <TableCell>
                    {t.title ?? "Untitled thread"}
                    {t.deletedAt && <> · in Trash</>}
                  </TableCell>
                  <TableCell>
                    <code className="break-all">{t.ownerUserId}</code>
                  </TableCell>
                  <TableCell>
                    <DateTime value={t.lastActivityAt} />
                  </TableCell>
                  <TableCell>
                    <Button size="sm" onClick={() => void loadEntries(t, 0)}>
                      Open
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {threads.length === 0 && !loading && !error && (
            <EmptyState title="No threads in scope." className="mt-3" />
          )}
          {cursor && (
            <Button className="mt-3" onClick={() => void loadThreads(cursor)}>
              Load more
            </Button>
          )}
        </Section>
      )}
    </>
  );
}
