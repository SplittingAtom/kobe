"use client";

import { useEffect, useRef, useState } from "react";
import {
  listSiteAudit,
  type AuditFilters,
  type SiteAuditEvent,
  type SiteAuditPage,
} from "../../../lib/admin/api/site/audit";
import {
  Button,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/console";
import { ErrorNotice } from "../error-notice";
import { DateTime } from "../parts";
import { useMutation } from "../use-resource";

const PLACEHOLDER = "—";
const HOUR_MS = 3_600_000;

/**
 * Whether an event's IP address and user agent may still be shown: only before the site's
 * erasure period has passed (KOBE-17). The server erases them; this keeps the page from showing a
 * value in the gap before the sweep runs. `hours` null (unknown) shows none.
 */
export function clientDetailsVisible(at: string, hours: number | null, now: number): boolean {
  if (hours === null) return false;
  const time = new Date(at).getTime();
  return Number.isFinite(time) && now - time < hours * HOUR_MS;
}

export function actorLabel(e: SiteAuditEvent): string {
  if (e.actor.kind === "system") return "Kobe (system)";
  if (e.actor.kind === "agent") return `Agent ${e.actor.id ?? ""}`.trim();
  return e.actor.name ?? e.actor.id ?? "Unknown";
}

/** A target value as text: strings as they are, anything else as JSON. Never markup. */
export function plainValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value) ?? String(value);
}

function Details({ target }: { readonly target: Record<string, unknown> }) {
  const entries = Object.entries(target);
  if (entries.length === 0) return <>{PLACEHOLDER}</>;
  return (
    <ul className="m-0 list-none p-0 text-sm">
      {entries.map(([key, value]) => (
        <li key={key} className="break-all">
          <span className="text-console-muted">{key}:</span> {plainValue(value)}
        </li>
      ))}
    </ul>
  );
}

function Client({ event, visible }: { readonly event: SiteAuditEvent; readonly visible: boolean }) {
  if (!visible || (event.ip === null && event.userAgent === null)) {
    return (
      <>
        <span aria-hidden="true">{PLACEHOLDER}</span>
        <span className="sr-only">Not shown</span>
      </>
    );
  }
  return (
    <div className="text-sm">
      {event.ip !== null && <div>{event.ip}</div>}
      {event.userAgent !== null && (
        <div className="break-all text-console-muted">{event.userAgent}</div>
      )}
    </div>
  );
}

/** "50 events", "1 event". */
export const eventCount = (n: number) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? "event" : "events"}`;

/**
 * One filtered view of the log: the first page plus the ones "Load more" fetched with the same
 * filters. The page mounts a new one (keyed by its view) for every filter change, and a page that
 * answers after this one is gone is dropped. Each page loaded is reported through `announce`;
 * when the last page arrives the button goes and focus moves to the Events heading.
 */
export function AuditEventsTable({
  first,
  filters,
  teamNames,
  piiHours,
  headingId,
  announce,
}: {
  readonly first: SiteAuditPage;
  readonly filters: AuditFilters;
  readonly teamNames: ReadonlyMap<string, string>;
  /** The site's IP and user agent erasure period; null when it could not be read. */
  readonly piiHours: number | null;
  /** The Events heading, which takes focus when "Load more" goes away. */
  readonly headingId: string;
  readonly announce: (message: string) => void;
}) {
  const [events, setEvents] = useState<readonly SiteAuditEvent[]>(first.events);
  const [cursor, setCursor] = useState<string | null>(first.nextCursor);
  const [focusHeading, setFocusHeading] = useState(false);
  const alive = useRef(true);
  const paging = useMutation();
  const now = Date.now();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!focusHeading) return;
    setFocusHeading(false);
    document.getElementById(headingId)?.focus();
  }, [focusHeading, headingId]);

  async function loadMore() {
    if (cursor === null) return;
    await paging.run(
      () => listSiteAudit(filters, cursor),
      (page: SiteAuditPage) => {
        if (!alive.current) return null;
        const total = events.length + page.events.length;
        setEvents((current) => [...current, ...page.events]);
        setCursor(page.nextCursor);
        announce(
          `Loaded ${eventCount(page.events.length)} more: ${eventCount(total)} shown` +
            (page.nextCursor === null ? ", the whole log for these filters." : "."),
        );
        if (page.nextCursor === null) setFocusHeading(true);
        return null;
      },
    );
  }

  if (events.length === 0) return <EmptyState title="No events match these filters." />;
  return (
    <>
      <Table caption="Audit events, newest first" hideCaption>
        <TableHead>
          <TableRow>
            <TableHeader numeric>#</TableHeader>
            <TableHeader>When</TableHeader>
            <TableHeader>Who</TableHeader>
            <TableHeader>Team</TableHeader>
            <TableHeader>What</TableHeader>
            <TableHeader>Details</TableHeader>
            <TableHeader>Client</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {events.map((e) => (
            <TableRow key={e.id}>
              <TableCell numeric>{e.seq}</TableCell>
              <TableCell className="whitespace-nowrap">
                <DateTime value={e.at} precise />
              </TableCell>
              <TableCell>
                {actorLabel(e)}
                {e.actor.kind === "user" && e.actor.email && (
                  <div className="text-sm text-console-muted">{e.actor.email}</div>
                )}
              </TableCell>
              <TableCell>
                {e.teamId === null ? "Site" : (teamNames.get(e.teamId) ?? e.teamId)}
              </TableCell>
              <TableCell>
                <code className="break-all">{e.action}</code>
              </TableCell>
              <TableCell>
                <Details target={e.target} />
              </TableCell>
              <TableCell>
                <Client event={e} visible={clientDetailsVisible(e.at, piiHours, now)} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {paging.error && <ErrorNotice error={paging.error} />}
      {cursor !== null && (
        <p>
          <Button loading={paging.pending} onClick={() => void loadMore()}>
            Load more
          </Button>
        </p>
      )}
    </>
  );
}
