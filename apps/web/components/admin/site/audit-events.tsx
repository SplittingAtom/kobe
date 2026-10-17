"use client";

import { useState } from "react";
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
import { MutationStatus } from "../error-notice";
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

/**
 * One filtered view of the log: the first page plus the ones "Load more" fetched with the same
 * filters. A new first page (filters applied or cleared) starts the list again.
 */
export function AuditEventsTable({
  first,
  filters,
  teamNames,
  piiHours,
}: {
  readonly first: SiteAuditPage;
  readonly filters: AuditFilters;
  readonly teamNames: ReadonlyMap<string, string>;
  /** The site's IP and user agent erasure period; null when it could not be read. */
  readonly piiHours: number | null;
}) {
  const [shown, setShown] = useState(first);
  const [events, setEvents] = useState<readonly SiteAuditEvent[]>(first.events);
  const [cursor, setCursor] = useState<string | null>(first.nextCursor);
  // Filters applied (or cleared): a new first page replaces the list and its cursor.
  if (shown !== first) {
    setShown(first);
    setEvents(first.events);
    setCursor(first.nextCursor);
  }
  const paging = useMutation();
  const now = Date.now();

  async function loadMore() {
    if (cursor === null) return;
    await paging.run(
      () => listSiteAudit(filters, cursor),
      (page: SiteAuditPage) => {
        setEvents((current) => [...current, ...page.events]);
        setCursor(page.nextCursor);
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
                <DateTime value={e.at} />
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
      <MutationStatus error={paging.error} notice={null} />
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
